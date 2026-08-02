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
    valid_batches,
    workbook_bytes,
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
        payload = json.dumps({}).encode()
        for origin in (None, "https://evil.example"):
            with self.subTest(origin=origin):
                headers = {"Content-Type": "application/json"}
                if origin is not None:
                    headers["Origin"] = origin
                status, _response_headers, body = self._request(
                    "POST",
                    "/analyze-artifacts",
                    payload,
                    headers,
                )
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(body)["error"], "ORIGIN_NOT_ALLOWED")

        status, _headers, body = self._request(
            "OPTIONS",
            "/analyze-artifacts",
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
            "/analyze-artifacts",
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

    def test_bundle_download_returns_zip_not_json(self) -> None:
        payload = {
            **self.task_payload(),
            "inputKind": "account",
        }
        status, _headers, _body = self._json_request("POST", "/project-tasks", payload)
        self.assertEqual(status, 200)
        status, _headers, _body = self._json_request(
            "PATCH", f"/project-tasks/{payload['id']}",
            {"inputKind": "account", "category": "xhs-account"},
        )
        self.assertEqual(status, 200)
        output = self.project_root / "outputs" / "competitor-insight" / "xiaohongshu" / payload["id"]
        output.mkdir(parents=True)
        report = output / "report.md"
        report.write_text("# report\n", encoding="utf-8")
        status, _headers, body = self._json_request(
            "POST", f"/project-tasks/{payload['id']}/artifacts",
            {"outputDir": str(output), "explicitPaths": [str(report)]},
        )
        self.assertEqual(status, 200)
        status, _headers, body = self._json_request(
            "POST", f"/project-tasks/{payload['id']}/bundle",
            {
                "platformId": "xiaohongshu", "inputKind": "account", "category": "xhs-account",
                "outputDir": str(output), "primaryReportPath": str(report),
                "explicitPaths": [str(report)], "subjectName": "测试账号", "itemCount": 1,
            },
        )
        self.assertEqual(status, 200)
        bundle_id = json.loads(body)["bundles"][0]["id"]

        status, headers, body = self._request(
            "GET", f"/project-bundles/{bundle_id}/download",
            headers={"Origin": "http://localhost:3000"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/zip")
        self.assertTrue(body.startswith(b"PK"))
        self.assertEqual(headers["access-control-allow-origin"], "http://localhost:3000")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["content-length"], str(len(body)))
        self.assertEqual(headers["content-disposition"], f'attachment; filename="{bundle_id}.zip"')

        status, _headers, body = self._request(
            "GET", f"/project-bundles/{bundle_id}",
            headers={"Origin": "http://localhost:3000"},
        )
        self.assertEqual(status, 200)
        detail = json.loads(body)
        self.assertEqual(detail["markdown"], "# report\n")
        self.assertTrue(detail["previewable"])

        status, _headers, body = self._request(
            "GET", f"/project-bundles/{bundle_id}/download",
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"], "ORIGIN_NOT_ALLOWED")

        with patch.object(
            project_records,
            "reveal_bundle",
            return_value={"ok": True, "bundleId": bundle_id},
        ) as reveal:
            status, _headers, body = self._json_request(
                "POST", f"/project-bundles/{bundle_id}/reveal", {},
            )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["bundleId"], bundle_id)
        reveal.assert_called_once_with(bundle_id)

        (output / f"{bundle_id}.zip").unlink()
        status, _headers, body = self._request(
            "GET", f"/project-bundles/{bundle_id}/download",
            headers={"Origin": "http://localhost:3000"},
        )
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "BUNDLE_MISSING")

        status, _headers, body = self._request(
            "GET", "/project-bundles/../../private/download",
            headers={"Origin": "http://localhost:3000"},
        )
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "NOT_FOUND")

    def test_bundle_routes_reject_query_method_and_origin_without_disconnect(self) -> None:
        bundle_id = "bundle-0000000000000001"
        routes = [
            ("GET", f"/project-bundles/{bundle_id}?unexpected=1", None),
            ("GET", f"/project-bundles/{bundle_id}/download?unexpected=1", None),
            ("POST", f"/project-tasks/competitor-20260801-http-a1/bundle?unexpected=1", {}),
            ("POST", f"/project-bundles/{bundle_id}/reveal?unexpected=1", {}),
        ]
        for method, path, payload in routes:
            with self.subTest(method=method, path=path):
                headers = {"Origin": "http://localhost:3000"}
                body = None
                if payload is not None:
                    headers["Content-Type"] = "application/json"
                    body = json.dumps(payload).encode("utf-8")
                status, _headers, response_body = self._request(method, path, body, headers)
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(response_body)["error"], "INVALID_REQUEST")
        for method, path, payload in (
            ("GET", f"/project-bundles/{bundle_id}", None),
            ("GET", f"/project-bundles/{bundle_id}/download", None),
            ("POST", "/project-tasks/competitor-20260801-http-a1/bundle", {}),
            ("POST", f"/project-bundles/{bundle_id}/reveal", {}),
        ):
            with self.subTest(method=method, path=path):
                headers = {"Origin": "https://evil.example"}
                body = None
                if payload is not None:
                    headers["Content-Type"] = "application/json"
                    body = json.dumps(payload).encode("utf-8")
                status, _headers, response_body = self._request(method, path, body, headers)
                self.assertEqual(status, 403)
                self.assertEqual(json.loads(response_body)["error"], "ORIGIN_NOT_ALLOWED")
        for method, path in (
            ("POST", f"/project-bundles/{bundle_id}"),
            ("POST", f"/project-bundles/{bundle_id}/download"),
            ("GET", "/project-tasks/competitor-20260801-http-a1/bundle"),
            ("GET", f"/project-bundles/{bundle_id}/reveal"),
            ("GET", "/project-bundles/bundle-not-hex"),
            ("POST", "/project-tasks/not-a-task/bundle"),
            ("POST", "/project-bundles/bundle-not-hex/reveal"),
        ):
            with self.subTest(method=method, path=path):
                headers = {"Origin": "http://localhost:3000"}
                body = None
                if method == "POST":
                    headers["Content-Type"] = "application/json"
                    body = b"{}"
                status, _headers, response_body = self._request(method, path, body, headers)
                self.assertEqual(status, 404)
                self.assertEqual(json.loads(response_body)["error"], "NOT_FOUND")

    def test_bundle_detail_hides_markdown_above_two_mebibytes(self) -> None:
        payload = {**self.task_payload(), "id": "competitor-20260801-http-b2", "inputKind": "account"}
        self.assertEqual(self._json_request("POST", "/project-tasks", payload)[0], 200)
        self.assertEqual(self._json_request("PATCH", f"/project-tasks/{payload['id']}", {"inputKind": "account", "category": "xhs-account"})[0], 200)
        output = self.project_root / "outputs" / "competitor-insight" / "xiaohongshu" / payload["id"]
        output.mkdir(parents=True)
        report = output / "large.md"
        report.write_text("x" * (2 * 1024 * 1024 + 1), encoding="utf-8")
        self.assertEqual(self._json_request("POST", f"/project-tasks/{payload['id']}/artifacts", {"outputDir": str(output), "explicitPaths": [str(report)]})[0], 200)
        status, _headers, body = self._json_request("POST", f"/project-tasks/{payload['id']}/bundle", {"platformId": "xiaohongshu", "inputKind": "account", "category": "xhs-account", "outputDir": str(output), "primaryReportPath": str(report), "explicitPaths": [str(report)], "subjectName": "测试账号", "itemCount": 1})
        self.assertEqual(status, 200)
        bundle_id = json.loads(body)["bundles"][0]["id"]
        status, _headers, body = self._request("GET", f"/project-bundles/{bundle_id}", headers={"Origin": "http://localhost:3000"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["markdown"], None)
        self.assertFalse(json.loads(body)["previewable"])

    def test_bundle_detail_previews_exactly_two_mebibytes(self) -> None:
        payload = {**self.task_payload(), "id": "competitor-20260801-http-c3", "inputKind": "account"}
        self.assertEqual(self._json_request("POST", "/project-tasks", payload)[0], 200)
        self.assertEqual(self._json_request("PATCH", f"/project-tasks/{payload['id']}", {"inputKind": "account", "category": "xhs-account"})[0], 200)
        output = self.project_root / "outputs" / "competitor-insight" / "xiaohongshu" / payload["id"]
        output.mkdir(parents=True)
        report = output / "limit.md"
        report.write_text("y" * (2 * 1024 * 1024), encoding="utf-8")
        self.assertEqual(self._json_request("POST", f"/project-tasks/{payload['id']}/artifacts", {"outputDir": str(output), "explicitPaths": [str(report)]})[0], 200)
        status, _headers, body = self._json_request("POST", f"/project-tasks/{payload['id']}/bundle", {"platformId": "xiaohongshu", "inputKind": "account", "category": "xhs-account", "outputDir": str(output), "primaryReportPath": str(report), "explicitPaths": [str(report)], "subjectName": "测试账号", "itemCount": 1})
        self.assertEqual(status, 200)
        bundle_id = json.loads(body)["bundles"][0]["id"]
        status, _headers, body = self._request("GET", f"/project-bundles/{bundle_id}", headers={"Origin": "http://localhost:3000"})
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["markdown"]), 2 * 1024 * 1024)
        self.assertTrue(json.loads(body)["previewable"])

        status, _headers, body = self._request(
            "GET", "/project-bundles/bundle-not-hex/download",
            headers={"Origin": "http://localhost:3000"},
        )
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "NOT_FOUND")

    def test_bundle_detail_hides_markdown_when_full_json_encoding_exceeds_client_cap(self) -> None:
        payload = {
            **self.task_payload(),
            "id": "competitor-20260801-http-json-cap",
            "inputKind": "account",
        }
        self.assertEqual(self._json_request("POST", "/project-tasks", payload)[0], 200)
        self.assertEqual(
            self._json_request(
                "PATCH",
                f"/project-tasks/{payload['id']}",
                {"inputKind": "account", "category": "xhs-account"},
            )[0],
            200,
        )
        output = (
            self.project_root / "outputs" / "competitor-insight"
            / "xiaohongshu" / payload["id"]
        )
        output.mkdir(parents=True)
        report = output / "escaped.md"
        report.write_text("\\" * (2 * 1024 * 1024), encoding="utf-8")
        self.assertEqual(
            self._json_request(
                "POST",
                f"/project-tasks/{payload['id']}/artifacts",
                {"outputDir": str(output), "explicitPaths": [str(report)]},
            )[0],
            200,
        )
        status, _headers, body = self._json_request(
            "POST",
            f"/project-tasks/{payload['id']}/bundle",
            {
                "platformId": "xiaohongshu", "inputKind": "account",
                "category": "xhs-account", "outputDir": str(output),
                "primaryReportPath": str(report), "explicitPaths": [str(report)],
                "subjectName": "测试账号", "itemCount": 1,
            },
        )
        self.assertEqual(status, 200)
        bundle_id = json.loads(body)["bundles"][0]["id"]

        status, _headers, body = self._request(
            "GET",
            f"/project-bundles/{bundle_id}",
            headers={"Origin": "http://localhost:3000"},
        )

        detail = json.loads(body)
        self.assertEqual(status, 200)
        self.assertLessEqual(len(body), 4 * 1024 * 1024)
        self.assertIsNone(detail["markdown"])
        self.assertFalse(detail["previewable"])

    def test_rejects_oversized_request_before_parsing_json(self) -> None:
        self.handler_class.max_body_bytes = 64
        status, _headers, body = self._request(
            "POST",
            "/analyze-artifacts",
            b"x" * 65,
            {
                "Content-Type": "application/json",
                "Origin": "http://localhost:3000",
            },
        )

        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body)["error"], "REQUEST_TOO_LARGE")

    def test_analyze_upload_is_not_a_route_for_any_origin(self) -> None:
        for origin in (None, "https://evil.example", "http://localhost:3000"):
            with self.subTest(origin=origin):
                headers = {"Content-Type": "application/json"}
                if origin is not None:
                    headers["Origin"] = origin
                status, _headers, body = self._request("POST", "/analyze-upload", b"{}", headers)
                self.assertEqual(status, 404)
                self.assertEqual(json.loads(body)["error"], "NOT_FOUND")

    def test_analyze_upload_tombstone_is_404_for_every_http_verb(self) -> None:
        for method in ("GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE", "HEAD"):
            for origin in (None, "https://evil.example", "http://localhost:3000"):
                with self.subTest(method=method, origin=origin):
                    headers = {} if origin is None else {"Origin": origin}
                    status, _headers, body = self._request(method, "/analyze-upload", b"{}" if method == "POST" else None, headers)
                    self.assertEqual(status, 404)
                    if method == "HEAD":
                        self.assertEqual(body, b"")
                    else:
                        self.assertEqual(json.loads(body)["error"], "NOT_FOUND")

    def test_analyze_artifacts_accepts_only_a_task_scoped_result_bundle(self) -> None:
        task_dir = self.project_root / "outputs" / "competitor-insight" / "douyin" / "competitor-20260801-http-a1"
        task_dir.mkdir(parents=True)
        data_path = task_dir / "结构化数据.json"
        data_path.write_text(json.dumps({"status": "success", "data": {"profile": {"nickname": "桥接账号", "sec_uid": "id"}, "videos": [{"desc": "作品", "statistics": {"digg_count": 1, "comment_count": 1, "collect_count": 1, "share_count": 1}, "create_time": "2026-07-01", "share_url": "https://example.com/1"}]}}), encoding="utf-8")
        payload = {
            "taskId": "competitor-20260801-http-a1",
            "platformId": "douyin",
            "inputKind": "account",
            "outputDir": str(task_dir.resolve()),
            "dataPath": str(data_path.resolve()),
            "excelPath": None,
        }

        status, _headers, body = self._post_json("/analyze-artifacts", payload)

        response = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(response["outputDir"], str(task_dir.resolve()))
        self.assertEqual(response["batchInputs"]["strategy"]["allowedEvidenceIds"], ["DY-E0001"])

    def test_errors_do_not_echo_stack_input_path_or_excel_body(self) -> None:
        secret_path = "/Users/example/private-secret.xlsx"
        status, _headers, body = self._post_json("/analyze-path", {"path": secret_path})

        self.assertEqual(status, 400)
        decoded = body.decode("utf-8")
        self.assertNotIn(secret_path, decoded)
        self.assertNotIn("Traceback", decoded)
        self.assertEqual(json.loads(body)["error"], "PATH_NOT_ALLOWED")

    def test_record_store_contention_is_a_retryable_service_error(self) -> None:
        with patch.object(
            project_records,
            "read_records",
            side_effect=ValueError("record_store_locked"),
        ):
            status, _headers, body = self._request(
                "GET",
                "/project-records?agentId=competitor-insight",
                headers={"Origin": "http://localhost:3000"},
            )

        payload = json.loads(body)
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"], "RECORD_STORE_LOCKED")

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
