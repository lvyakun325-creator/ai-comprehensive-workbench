import base64
import http.client
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

from http.server import ThreadingHTTPServer


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bridge_server
import service
from test_service import valid_batches, workbook_bytes


class BridgeServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.project_root = Path(self.temporary_directory.name)
        self.project_patch = patch.object(service, "PROJECT_ROOT", self.project_root)
        self.project_patch.start()

        class TestBridgeHandler(bridge_server.BridgeHandler):
            max_body_bytes = bridge_server.MAX_REQUEST_BYTES
            max_response_bytes = bridge_server.MAX_RESPONSE_BYTES

        self.handler_class = TestBridgeHandler
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.handler_class)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.project_patch.stop()
        self.temporary_directory.cleanup()

    def _request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response_body = response.read()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        connection.close()
        return response.status, response_headers, response_body

    def _post_json(self, path: str, payload: object) -> tuple[int, dict[str, str], bytes]:
        return self._request(
            "POST",
            path,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            {
                "Content-Type": "application/json",
                "Origin": "http://localhost:3000",
            },
        )

    def test_health_allows_a_request_without_origin(self) -> None:
        status, headers, body = self._request("GET", "/health")

        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        self.assertEqual(json.loads(body), {"ok": True, "stage": "healthy"})

    def test_write_endpoints_reject_missing_or_malicious_origins(self) -> None:
        payload = json.dumps({"filename": "sample.xlsx", "contentBase64": ""}).encode()
        for origin in (None, "https://evil.example"):
            with self.subTest(origin=origin):
                headers = {"Content-Type": "application/json"}
                if origin is not None:
                    headers["Origin"] = origin
                status, _response_headers, body = self._request(
                    "POST",
                    "/analyze-upload",
                    payload,
                    headers,
                )
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(body)["error"], "ORIGIN_NOT_ALLOWED")

        status, _headers, body = self._request(
            "OPTIONS",
            "/analyze-upload",
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"], "ORIGIN_NOT_ALLOWED")

    def test_allowed_preflight_returns_only_the_allowed_origin(self) -> None:
        status, headers, body = self._request(
            "OPTIONS",
            "/assemble-report",
            headers={"Origin": "http://127.0.0.1:3000"},
        )

        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertEqual(headers["access-control-allow-origin"], "http://127.0.0.1:3000")

    def test_rejects_oversized_request_before_parsing_json(self) -> None:
        self.handler_class.max_body_bytes = 64
        status, _headers, body = self._request(
            "POST",
            "/analyze-upload",
            b"x" * 65,
            {
                "Content-Type": "application/json",
                "Origin": "http://localhost:3000",
            },
        )

        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)["error"], "REQUEST_TOO_LARGE")

    def test_rejects_non_json_and_invalid_base64_with_stable_errors(self) -> None:
        status, _headers, body = self._request(
            "POST",
            "/analyze-upload",
            b"plain text",
            {
                "Content-Type": "text/plain",
                "Origin": "http://localhost:3000",
            },
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "INVALID_JSON")

        status, _headers, body = self._post_json(
            "/analyze-upload",
            {"filename": "sample.xlsx", "contentBase64": "%%%"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "INVALID_BASE64")

    def test_analyze_upload_uses_the_fixed_json_boundary(self) -> None:
        status, headers, body = self._post_json(
            "/analyze-upload",
            {
                "filename": "sample.xlsx",
                "contentBase64": base64.b64encode(workbook_bytes()).decode("ascii"),
            },
        )

        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(payload["stage"], "evidence_ready")
        self.assertRegex(payload["evidenceId"], r"^[0-9a-f]{16}$")
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:3000")

    def test_errors_do_not_echo_stack_input_path_or_excel_body(self) -> None:
        secret_path = "/Users/example/private-secret.xlsx"
        status, _headers, body = self._post_json("/analyze-path", {"path": secret_path})

        self.assertEqual(status, 400)
        decoded = body.decode("utf-8")
        self.assertNotIn(secret_path, decoded)
        self.assertNotIn("Traceback", decoded)
        self.assertEqual(json.loads(body)["error"], "PATH_NOT_ALLOWED")

    def test_oversized_report_is_retained_but_not_returned_for_preview(self) -> None:
        evidence = service.analyze_upload("sample.xlsx", workbook_bytes())
        self.handler_class.max_response_bytes = 512

        status, _headers, body = self._post_json(
            "/assemble-report",
            {
                "evidenceId": evidence["evidenceId"],
                "batches": valid_batches(),
            },
        )

        payload = json.loads(body)
        reports_root = (
            self.project_root / "outputs" / "competitor-insight" / "reports"
        )
        self.assertEqual(status, 413)
        self.assertLessEqual(len(body), 512)
        self.assertEqual(payload["error"], "REPORT_TOO_LARGE_FOR_PREVIEW")
        self.assertNotIn("markdown", payload)
        self.assertEqual(len(list(reports_root.glob("*_抖音账号分析报告_*.md"))), 1)


if __name__ == "__main__":
    unittest.main()
