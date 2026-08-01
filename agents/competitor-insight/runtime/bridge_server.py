"""Loopback-only HTTP bridge for the controlled competitor report service."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
from typing import cast
from urllib.parse import parse_qs, urlsplit
import zipfile

import project_records
import service


HOST = "127.0.0.1"
PORT = 8768
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
ALLOWED_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://zhongfan-ai-workbench.lvyakun325.chatgpt.site",
}
WRITE_ENDPOINTS = {
    "/analyze-path",
    "/analyze-artifacts",
    "/validate-section",
    "/assemble-report",
}
TASK_PATH = re.compile(r"^/project-tasks/(?P<task_id>competitor-[0-9A-Za-z-]{4,120})$")
ARTIFACTS_PATH = re.compile(
    r"^/project-tasks/(?P<task_id>competitor-[0-9A-Za-z-]{4,120})/artifacts$"
)
REVEAL_PATH = re.compile(
    r"^/project-artifacts/(?P<artifact_id>artifact-[0-9a-f]{16})/reveal$"
)
BUNDLE_TASK_PATH = re.compile(
    r"^/project-tasks/(?P<task_id>competitor-[0-9A-Za-z-]{4,120})/bundle$"
)
BUNDLE_PATH = re.compile(r"^/project-bundles/(?P<bundle_id>bundle-[0-9a-f]{16})$")
BUNDLE_DOWNLOAD_PATH = re.compile(r"^/project-bundles/(?P<bundle_id>bundle-[0-9a-f]{16})/download$")
BUNDLE_REVEAL_PATH = re.compile(r"^/project-bundles/(?P<bundle_id>bundle-[0-9a-f]{16})/reveal$")

_ERRORS = {
    "unsafe_output_path": (503, "INTERNAL_SECURITY_BOUNDARY", "报告输出目录未通过安全校验。"),
    "path_outside_douyin_output": (400, "PATH_NOT_ALLOWED", "只能读取受控抖音输出目录中的 Excel。"),
    "symlink_not_allowed": (400, "SYMLINK_NOT_ALLOWED", "不允许读取符号链接。"),
    "secure_nofollow_unavailable": (503, "INTERNAL_SECURITY_BOUNDARY", "当前系统缺少安全路径读取能力。"),
    "secure_directory_unavailable": (503, "INTERNAL_SECURITY_BOUNDARY", "当前系统缺少安全目录读取能力。"),
    "invalid_path": (400, "INVALID_REQUEST", "请求路径无效。"),
    "invalid_xlsx_path": (400, "INVALID_WORKBOOK", "Excel 文件不存在或不是普通文件。"),
    "invalid_extension": (400, "INVALID_WORKBOOK", "仅支持 .xlsx 文件。"),
    "invalid_xlsx_signature": (400, "INVALID_WORKBOOK", "上传内容不是有效的 XLSX 文件。"),
    "xlsx_archive_too_large": (413, "XLSX_ARCHIVE_TOO_LARGE", "XLSX 解压规模超过安全上限。"),
    "invalid_workbook": (400, "INVALID_WORKBOOK", "Excel 中没有可用的作品数据。"),
    "missing_title_field": (400, "INVALID_WORKBOOK", "Excel 中没有可用的作品数据。"),
    "no_work_rows": (400, "INVALID_WORKBOOK", "Excel 中没有可用的作品数据。"),
    "missing_account_sheet": (400, "INVALID_WORKBOOK", "Excel 中没有独立的抖音账号信息表。"),
    "missing_account_identity": (400, "INVALID_WORKBOOK", "Excel 中没有可验证的抖音账号身份。"),
    "invalid_account_identity": (400, "INVALID_WORKBOOK", "Excel 账号信息超出安全边界。"),
    "wrong_platform_account_sheet": (400, "INVALID_WORKBOOK", "Excel 不是可验证的抖音账号导出。"),
    "excel_too_large": (413, "EXCEL_TOO_LARGE", "Excel 文件超过 50 MB 上限。"),
    "invalid_filename": (400, "INVALID_REQUEST", "上传文件名无效。"),
    "invalid_upload_content": (400, "INVALID_REQUEST", "上传内容无效。"),
    "workbook_changed_during_read": (400, "INVALID_WORKBOOK", "Excel 在读取过程中发生变化。"),
    "invalid_evidence_id": (400, "INVALID_EVIDENCE_ID", "证据会话 ID 无效。"),
    "evidence_not_found": (404, "EVIDENCE_NOT_FOUND", "证据会话不存在。"),
    "invalid_evidence_bundle": (400, "INVALID_EVIDENCE", "证据包无效。"),
    "invalid_request_fields": (400, "INVALID_REQUEST", "请求参数无效。"),
    "invalid_task_id": (400, "INVALID_REQUEST", "任务 ID 无效。"),
    "invalid_artifact_id": (400, "INVALID_REQUEST", "成果 ID 无效。"),
    "invalid_bundle_id": (400, "INVALID_REQUEST", "成果包 ID 无效。"),
    "invalid_agent_id": (400, "INVALID_REQUEST", "Agent ID 无效。"),
    "invalid_source_url": (400, "INVALID_REQUEST", "抓取链接无效。"),
    "invalid_status": (400, "INVALID_REQUEST", "任务状态无效。"),
    "invalid_status_transition": (409, "INVALID_TASK_STATE", "任务状态不能这样更新。"),
    "invalid_progress": (400, "INVALID_REQUEST", "任务进度无效。"),
    "invalid_explicit_paths": (400, "INVALID_REQUEST", "成果路径清单无效。"),
    "invalid_output_directory": (400, "INVALID_REQUEST", "成果输出目录无效。"),
    "task_already_exists": (409, "TASK_ALREADY_EXISTS", "任务已经存在。"),
    "task_not_found": (404, "TASK_NOT_FOUND", "任务不存在。"),
    "artifact_not_found": (404, "ARTIFACT_NOT_FOUND", "成果不存在。"),
    "artifact_missing": (404, "ARTIFACT_MISSING", "成果文件已不存在。"),
    "bundle_not_found": (404, "BUNDLE_NOT_FOUND", "成果包不存在。"),
    "bundle_missing": (404, "BUNDLE_MISSING", "成果包文件已不存在。"),
    "bundle_path_unsafe": (503, "INTERNAL_SECURITY_BOUNDARY", "成果包安全校验未通过。"),
    "path_not_allowed": (400, "PATH_NOT_ALLOWED", "成果路径不在受控目录中。"),
    "artifact_scan_failed": (500, "ARTIFACT_SCAN_FAILED", "成果目录扫描失败。"),
    "too_many_artifacts": (413, "TOO_MANY_ARTIFACTS", "本次成果文件数量超过上限。"),
    "record_store_damaged": (503, "RECORD_STORE_DAMAGED", "本地任务记录需要修复。"),
    "reveal_failed": (500, "REVEAL_FAILED", "无法在访达中显示该成果。"),
}


def _value_error_response(error: ValueError) -> tuple[int, dict[str, object]]:
    stable = str(error).split(":", 1)[0]
    if stable in _ERRORS:
        status, code, message = _ERRORS[stable]
    elif stable.startswith(("missing_batch_id", "duplicate_batch_id", "invalid_batch_id")):
        status, code, message = 400, "INVALID_REPORT_BATCHES", "报告必须包含三类有效批次。"
    elif stable == "final_report_validation_failed":
        status, code, message = 400, "FINAL_REPORT_INVALID", "最终报告校验未通过。"
    else:
        status, code, message = 400, "INVALID_SECTION", "报告分段数据未通过校验。"
    return status, {"ok": False, "error": code, "message": message}


class BridgeHandler(BaseHTTPRequestHandler):
    """Stateless request handler; all report session state is loaded from disk."""

    max_body_bytes = MAX_REQUEST_BYTES
    max_response_bytes = MAX_RESPONSE_BYTES

    def log_message(self, _format: str, *args: object) -> None:
        return

    def _origin(self) -> str | None:
        return self.headers.get("Origin")

    def _send_json(
        self,
        status: int,
        payload: dict[str, object],
        *,
        origin: str | None = None,
    ) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(
        self,
        body: bytes,
        *,
        filename: str,
        origin: str,
    ) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _origin_allowed(self) -> bool:
        origin = self._origin()
        if origin in ALLOWED_ORIGINS:
            return True
        self._send_json(
            403,
            {
                "ok": False,
                "error": "ORIGIN_NOT_ALLOWED",
                "message": "请求来源不在允许列表中。",
            },
        )
        return False

    def _request_path(self) -> str:
        return urlsplit(self.path).path

    def _not_found(self, *, head: bool = False) -> None:
        payload = {"ok": False, "error": "NOT_FOUND", "message": "接口不存在。"}
        if not head:
            self._send_json(404, payload)
            return
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(404)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_HEAD(self) -> None:
        self._not_found(head=True)

    def do_PUT(self) -> None:
        self._not_found()

    def do_DELETE(self) -> None:
        self._not_found()

    def _is_write_endpoint(self) -> bool:
        path = self._request_path()
        return bool(
            path in WRITE_ENDPOINTS
            or path == "/project-tasks"
            or TASK_PATH.fullmatch(path)
            or ARTIFACTS_PATH.fullmatch(path)
            or REVEAL_PATH.fullmatch(path)
            or BUNDLE_TASK_PATH.fullmatch(path)
            or BUNDLE_REVEAL_PATH.fullmatch(path)
        )

    def do_OPTIONS(self) -> None:
        if not self._is_write_endpoint():
            self._send_json(
                404,
                {"ok": False, "error": "NOT_FOUND", "message": "接口不存在。"},
            )
            return
        if not self._origin_allowed():
            return
        origin = cast(str, self._origin())
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/health" and not parsed.query:
            origin = self._origin()
            if origin is not None and origin not in ALLOWED_ORIGINS:
                self._send_json(
                    403,
                    {
                        "ok": False,
                        "error": "ORIGIN_NOT_ALLOWED",
                        "message": "请求来源不在允许列表中。",
                    },
                )
                return
            self._send_json(
                200,
                {
                    "ok": True,
                    "stage": "healthy",
                    "service": "competitor-insight-report",
                },
                origin=origin,
            )
            return
        bundle_match = BUNDLE_PATH.fullmatch(parsed.path)
        download_match = BUNDLE_DOWNLOAD_PATH.fullmatch(parsed.path)
        if bundle_match or download_match:
            if parsed.query or not self._origin_allowed():
                return
            bundle_id = (bundle_match or download_match).group("bundle_id")
            try:
                if download_match:
                    archive = project_records.bundle_archive(bundle_id)
                    self._send_binary(
                        archive.read_bytes(),
                        filename=f"{bundle_id}.zip",
                        origin=cast(str, self._origin()),
                    )
                    return
                bundle = project_records.read_bundle(bundle_id)
                snapshot = project_records.read_records("competitor-insight")
                primary_path = bundle.get("primaryReportPath")
                markdown: str | None = None
                previewable = False
                if isinstance(primary_path, str):
                    archive = project_records.bundle_archive(bundle_id)
                    with zipfile.ZipFile(archive) as package:
                        manifest = json.loads(package.read("bundle-manifest.json"))
                        primary = manifest.get("primaryReport") if isinstance(manifest, dict) else None
                        if isinstance(primary, str):
                            info = package.getinfo(primary)
                            if info.file_size <= self.max_response_bytes:
                                markdown = package.read(primary).decode("utf-8")
                                previewable = True
                task = next((item for item in snapshot["tasks"] if item.get("id") == bundle.get("taskId")), None)
                artifacts = [item for item in snapshot["artifacts"] if item.get("taskId") == bundle.get("taskId")]
                if task is None:
                    raise ValueError("record_store_damaged")
                self._send_json(200, {"ok": True, "bundle": bundle, "task": task, "artifacts": artifacts, "markdown": markdown, "previewable": previewable}, origin=self._origin())
                return
            except ValueError as error:
                status, response = _value_error_response(error)
                self._send_json(status, response, origin=self._origin())
                return
            except (OSError, UnicodeError, json.JSONDecodeError, zipfile.BadZipFile, KeyError):
                self._send_json(500, {"ok": False, "error": "INTERNAL_ERROR", "message": "本地任务服务处理失败。"}, origin=self._origin())
                return
        if parsed.path != "/project-records":
            self._send_json(
                404,
                {"ok": False, "error": "NOT_FOUND", "message": "接口不存在。"},
            )
            return
        if not self._origin_allowed():
            return
        query = parse_qs(parsed.query, keep_blank_values=True)
        if set(query) != {"agentId"} or len(query["agentId"]) != 1:
            self._send_json(
                400,
                {"ok": False, "error": "INVALID_REQUEST", "message": "请求参数无效。"},
                origin=self._origin(),
            )
            return
        try:
            snapshot = project_records.read_records(query["agentId"][0])
        except ValueError as error:
            status, response = _value_error_response(error)
            self._send_json(status, response, origin=self._origin())
            return
        self._send_json(
            200,
            {"ok": True, **snapshot},
            origin=self._origin(),
        )

    def _read_json(self) -> dict[str, object] | None:
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().casefold() != "application/json":
            self._send_json(
                400,
                {"ok": False, "error": "INVALID_JSON", "message": "请求体必须是 JSON。"},
                origin=self._origin(),
            )
            return None
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            content_length = -1
        if content_length < 0:
            self._send_json(
                400,
                {"ok": False, "error": "INVALID_JSON", "message": "请求体必须是 JSON。"},
                origin=self._origin(),
            )
            return None
        if content_length > self.max_body_bytes:
            self._send_json(
                413,
                {
                    "ok": False,
                    "error": "REQUEST_TOO_LARGE",
                    "message": "请求体超过本地桥接传输上限。",
                },
                origin=self._origin(),
            )
            return None
        raw = self.rfile.read(content_length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            self._send_json(
                400,
                {"ok": False, "error": "INVALID_JSON", "message": "请求体必须是有效 JSON。"},
                origin=self._origin(),
            )
            return None
        if not isinstance(payload, dict):
            self._send_json(
                400,
                {"ok": False, "error": "INVALID_JSON", "message": "JSON 顶层必须是对象。"},
                origin=self._origin(),
            )
            return None
        return cast(dict[str, object], payload)

    @staticmethod
    def _exact_fields(payload: dict[str, object], fields: set[str]) -> None:
        if set(payload) != fields:
            raise ValueError("invalid_request_fields")

    @staticmethod
    def _text(payload: dict[str, object], field: str) -> str:
        value = payload[field]
        if not isinstance(value, str) or not value:
            raise ValueError(f"invalid_{field}")
        return value

    def _dispatch(self, payload: dict[str, object]) -> dict[str, object]:
        path = self._request_path()
        if path == "/project-tasks":
            return {"ok": True, "task": project_records.create_task(payload)}
        artifacts_match = ARTIFACTS_PATH.fullmatch(path)
        if artifacts_match:
            snapshot = project_records.register_artifacts(
                artifacts_match.group("task_id"),
                payload,
            )
            return {"ok": True, **snapshot}
        bundle_task_match = BUNDLE_TASK_PATH.fullmatch(path)
        if bundle_task_match:
            snapshot = project_records.finalize_bundle(bundle_task_match.group("task_id"), payload)
            return {"ok": True, **snapshot}
        reveal_match = REVEAL_PATH.fullmatch(path)
        if reveal_match:
            self._exact_fields(payload, set())
            return project_records.reveal_artifact(reveal_match.group("artifact_id"))
        bundle_reveal_match = BUNDLE_REVEAL_PATH.fullmatch(path)
        if bundle_reveal_match:
            self._exact_fields(payload, set())
            return project_records.reveal_bundle(bundle_reveal_match.group("bundle_id"))
        if path == "/analyze-path":
            self._exact_fields(payload, {"path"})
            return service.analyze_path(self._text(payload, "path"))
        if path == "/analyze-artifacts":
            return service.analyze_artifacts(payload)
        if path == "/validate-section":
            if set(payload) not in ({"evidenceId", "outputDir", "batch"}, {"evidenceId", "batch"}):
                raise ValueError("invalid_request_fields")
            return service.validate_batch(
                self._text(payload, "evidenceId"),
                payload["batch"],
                self._text(payload, "outputDir") if "outputDir" in payload else None,
            )
        if path == "/assemble-report":
            if set(payload) not in ({"evidenceId", "outputDir", "batches"}, {"evidenceId", "batches"}):
                raise ValueError("invalid_request_fields")
            batches = payload["batches"]
            if not isinstance(batches, list):
                raise ValueError("invalid_batches")
            return cast(
                dict[str, object],
                service.assemble(
                    self._text(payload, "evidenceId"),
                    cast(list[object], batches),
                    self._text(payload, "outputDir") if "outputDir" in payload else None,
                ),
            )
        raise ValueError("unknown_endpoint")

    def do_POST(self) -> None:
        if not self._is_write_endpoint() or TASK_PATH.fullmatch(self._request_path()):
            self._send_json(
                404,
                {"ok": False, "error": "NOT_FOUND", "message": "接口不存在。"},
            )
            return
        if not self._origin_allowed():
            return
        payload = self._read_json()
        if payload is None:
            return
        try:
            result = self._dispatch(payload)
        except ValueError as error:
            status, response = _value_error_response(error)
            self._send_json(status, response, origin=self._origin())
            return
        except Exception:
            self._send_json(
                500,
                {
                    "ok": False,
                    "error": "INTERNAL_ERROR",
                    "message": "本地报告服务处理失败。",
                },
                origin=self._origin(),
            )
            return

        body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > self.max_response_bytes:
            self._send_json(
                413,
                {
                    "ok": False,
                    "error": "REPORT_TOO_LARGE_FOR_PREVIEW",
                    "message": "报告已保存在本地，但内容超过预览上限。",
                },
                origin=self._origin(),
            )
            return
        self._send_json(200, result, origin=self._origin())

    def do_PATCH(self) -> None:
        task_match = TASK_PATH.fullmatch(self._request_path())
        if task_match is None:
            self._send_json(
                404,
                {"ok": False, "error": "NOT_FOUND", "message": "接口不存在。"},
            )
            return
        if not self._origin_allowed():
            return
        payload = self._read_json()
        if payload is None:
            return
        try:
            task = project_records.update_task(task_match.group("task_id"), payload)
        except ValueError as error:
            status, response = _value_error_response(error)
            self._send_json(status, response, origin=self._origin())
            return
        except Exception:
            self._send_json(
                500,
                {
                    "ok": False,
                    "error": "INTERNAL_ERROR",
                    "message": "本地任务服务处理失败。",
                },
                origin=self._origin(),
            )
            return
        self._send_json(
            200,
            {"ok": True, "task": task},
            origin=self._origin(),
        )


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
