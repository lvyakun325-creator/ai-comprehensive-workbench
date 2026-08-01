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
import project_records
import service
from test_service import (
    malformed_account_workbook_bytes,
    valid_batches,
    workbook_bytes,
    xlsx_with_compression_bomb,
)


class BridgeServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.project_root = Path(self.temporary_directory.name)
        self.project_patch = patch.object(service, "PROJECT_ROOT", self.project_root)
        self.project_patch.start()
        self.records_project_patch = patch.object(
            project_records,
            "PROJECT_ROOT",
            self.project_root,
        )
        self.records_project_patch.start()

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
        self.records_project_patch.stop()
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
        return self._json_request("POST", path, payload)

    def _json_request(
        self,
        method: str,
        path: str,
        payload: object,
    ) -> tuple[int, dict[str, str], bytes]:
        return self._request(
            method,
            path,
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            {
                "Content-Type": "application/json",
                "Origin": "http://localhost:3000",
            },
        )

    def task_payload(self) -> dict[str, object]:
        return {
            "id": "competitor-20260801-http-a1",
            "agentId": "competitor-insight",
            "title": "小红书作品抓取",
            "platformId": "xiaohongshu",
            "platformLabel": "小红书",
            "skillId": "xiaohongshu-scraper",
            "sourceUrl": (
                "https://www.xiaohongshu.com/explore/abc"
                "?xsec_token=must-not-persist&source=feed"
            ),
            "model": "xiaohongshu-scraper",
        }

    def test_health_allows_a_request_without_origin(self) -> None:
        status, headers, body = self._request("GET", "/health")

        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        self.assertEqual(json.loads(body), {
            "ok": True,
            "stage": "healthy",
            "service": "competitor-insight-report",
        })

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

    def test_production_preflight_allows_exact_origin_and_private_network(self) -> None:
        production_origin = "https://zhongfan-ai-workbench.lvyakun325.chatgpt.site"
        status, headers, body = self._request(
            "OPTIONS",
            "/analyze-upload",
            headers={
                "Origin": production_origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )

        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertEqual(headers["access-control-allow-origin"], production_origin)
        self.assertEqual(headers["access-control-allow-private-network"], "true")

    def test_project_task_lifecycle_is_persisted_and_queryable(self) -> None:
        status, _headers, body = self._json_request(
            "POST",
            "/project-tasks",
            self.task_payload(),
        )
        self.assertEqual(status, 200)
        created = json.loads(body)["task"]
        self.assertEqual(created["sourceUrl"], "https://www.xiaohongshu.com/explore/abc")
        self.assertNotIn("must-not-persist", body.decode("utf-8"))

        status, _headers, body = self._json_request(
            "PATCH",
            "/project-tasks/competitor-20260801-http-a1",
            {
                "status": "running",
                "progress": 60,
                "currentStep": "正在抓取平台数据",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["task"]["progress"], 60)

        status, headers, body = self._request(
            "GET",
            "/project-records?agentId=competitor-insight",
            headers={"Origin": "http://localhost:3000"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:3000")
        snapshot = json.loads(body)
        self.assertTrue(snapshot["ok"])
        self.assertEqual(snapshot["tasks"][0]["id"], "competitor-20260801-http-a1")

    def test_project_record_reads_and_writes_reject_unapproved_origins(self) -> None:
        for method, path, payload in (
            ("GET", "/project-records?agentId=competitor-insight", None),
            ("POST", "/project-tasks", self.task_payload()),
            (
                "PATCH",
                "/project-tasks/competitor-20260801-http-a1",
                {"status": "running"},
            ),
        ):
            with self.subTest(method=method, path=path):
                body = None if payload is None else json.dumps(payload).encode("utf-8")
                headers = {} if payload is None else {"Content-Type": "application/json"}
                status, _response_headers, response_body = self._request(
                    method,
                    path,
                    body,
                    headers,
                )
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(response_body)["error"], "ORIGIN_NOT_ALLOWED")

    def test_registers_artifacts_and_reveals_only_by_persisted_id(self) -> None:
        self._json_request("POST", "/project-tasks", self.task_payload())
        output = (
            self.project_root
            / "outputs"
            / "competitor-insight"
            / "xiaohongshu"
            / "run-http"
        )
        output.mkdir(parents=True)
        workbook = output / "result.xlsx"
        workbook.write_bytes(b"xlsx")

        status, _headers, body = self._json_request(
            "POST",
            "/project-tasks/competitor-20260801-http-a1/artifacts",
            {"outputDir": str(output), "explicitPaths": [str(workbook)]},
        )
        self.assertEqual(status, 200)
        snapshot = json.loads(body)
        workbook_artifact = next(
            item for item in snapshot["artifacts"] if item["kind"] == "excel"
        )

        with patch.object(
            project_records,
            "reveal_artifact",
            return_value={"ok": True, "artifactId": workbook_artifact["id"]},
        ) as reveal:
            status, _headers, body = self._json_request(
                "POST",
                f"/project-artifacts/{workbook_artifact['id']}/reveal",
                {},
            )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["artifactId"], workbook_artifact["id"])
        reveal.assert_called_once_with(workbook_artifact["id"])

        status, _headers, body = self._json_request(
            "POST",
            f"/project-artifacts/{workbook_artifact['id']}/reveal",
            {"path": "/tmp/escape"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "INVALID_REQUEST")

    def test_project_task_preflight_advertises_patch_without_wildcard_origin(self) -> None:
        status, headers, body = self._request(
            "OPTIONS",
            "/project-tasks/competitor-20260801-http-a1",
            headers={
                "Origin": "https://zhongfan-ai-workbench.lvyakun325.chatgpt.site",
                "Access-Control-Request-Method": "PATCH",
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )

        self.assertEqual(status, 204)
        self.assertEqual(body, b"")
        self.assertEqual(headers["access-control-allow-methods"], "GET, POST, PATCH, OPTIONS")
        self.assertEqual(
            headers["access-control-allow-origin"],
            "https://zhongfan-ai-workbench.lvyakun325.chatgpt.site",
        )
        self.assertEqual(headers["access-control-allow-private-network"], "true")

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

    def test_transport_limit_accommodates_base64_and_decoded_excel_limit_still_applies(self) -> None:
        valid = workbook_bytes()
        encoded_limit = ((service.MAX_EXCEL_BYTES + 2) // 3) * 4
        self.assertGreaterEqual(
            bridge_server.MAX_REQUEST_BYTES,
            encoded_limit + 1024 * 1024,
        )
        self.handler_class.max_body_bytes = len(valid) * 2 + 1024

        with patch.object(service, "MAX_EXCEL_BYTES", len(valid)):
            status, _headers, body = self._post_json(
                "/analyze-upload",
                {
                    "filename": "at-limit.xlsx",
                    "contentBase64": base64.b64encode(valid).decode("ascii"),
                },
            )
            self.assertEqual(status, 200)

            status, _headers, body = self._post_json(
                "/analyze-upload",
                {
                    "filename": "over-limit.xlsx",
                    "contentBase64": base64.b64encode(valid + b"x").decode("ascii"),
                },
            )
            self.assertEqual(status, 413)
            self.assertEqual(json.loads(body)["error"], "EXCEL_TOO_LARGE")

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

    def test_missing_secure_nofollow_has_stable_safe_http_error(self) -> None:
        douyin_root = (
            self.project_root / "outputs" / "competitor-insight" / "douyin"
        )
        douyin_root.mkdir(parents=True)
        workbook_path = douyin_root / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes())

        with patch.object(service.os, "O_NOFOLLOW", 0):
            status, _headers, body = self._post_json(
                "/analyze-path",
                {"path": str(workbook_path)},
            )

        decoded = body.decode("utf-8")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "INTERNAL_SECURITY_BOUNDARY")
        self.assertNotIn(str(workbook_path), decoded)

    def test_missing_secure_directory_open_has_stable_safe_http_error(self) -> None:
        douyin_root = (
            self.project_root / "outputs" / "competitor-insight" / "douyin"
        )
        douyin_root.mkdir(parents=True)
        workbook_path = douyin_root / "account.xlsx"
        workbook_path.write_bytes(workbook_bytes())

        with patch.object(service.os, "O_DIRECTORY", 0):
            status, _headers, body = self._post_json(
                "/analyze-path",
                {"path": str(workbook_path)},
            )

        decoded = body.decode("utf-8")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"], "INTERNAL_SECURITY_BOUNDARY")
        self.assertNotIn(str(workbook_path), decoded)

    def test_archive_bomb_and_internal_workbook_value_error_have_safe_http_codes(self) -> None:
        cases = (
            (
                xlsx_with_compression_bomb(),
                "XLSX_ARCHIVE_TOO_LARGE",
                "compression-bomb",
            ),
            (
                malformed_account_workbook_bytes(),
                "INVALID_WORKBOOK",
                "not enough values to unpack",
            ),
        )
        for content, error_code, forbidden in cases:
            with self.subTest(error_code=error_code):
                status, _headers, body = self._post_json(
                    "/analyze-upload",
                    {
                        "filename": "sample.xlsx",
                        "contentBase64": base64.b64encode(content).decode("ascii"),
                    },
                )
                decoded = body.decode("utf-8")
                expected_status = 413 if error_code == "XLSX_ARCHIVE_TOO_LARGE" else 400
                self.assertEqual(status, expected_status)
                self.assertEqual(json.loads(body)["error"], error_code)
                self.assertNotIn(forbidden, decoded)

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
