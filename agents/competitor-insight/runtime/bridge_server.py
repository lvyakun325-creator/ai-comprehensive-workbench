"""Loopback-only HTTP bridge for the controlled competitor report service."""

from __future__ import annotations

import base64
import binascii
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from typing import cast

import service


HOST = "127.0.0.1"
PORT = 8768
MAX_REQUEST_BYTES = ((service.MAX_EXCEL_BYTES + 2) // 3) * 4 + 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
ALLOWED_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
}
WRITE_ENDPOINTS = {
    "/analyze-path",
    "/analyze-upload",
    "/validate-section",
    "/assemble-report",
}

_ERRORS = {
    "unsafe_output_path": (503, "INTERNAL_SECURITY_BOUNDARY", "报告输出目录未通过安全校验。"),
    "path_outside_douyin_output": (400, "PATH_NOT_ALLOWED", "只能读取受控抖音输出目录中的 Excel。"),
    "symlink_not_allowed": (400, "SYMLINK_NOT_ALLOWED", "不允许读取符号链接。"),
    "secure_nofollow_unavailable": (503, "INTERNAL_SECURITY_BOUNDARY", "当前系统缺少安全路径读取能力。"),
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
    "excel_too_large": (413, "EXCEL_TOO_LARGE", "Excel 文件超过 50 MB 上限。"),
    "invalid_filename": (400, "INVALID_REQUEST", "上传文件名无效。"),
    "invalid_upload_content": (400, "INVALID_REQUEST", "上传内容无效。"),
    "workbook_changed_during_read": (400, "INVALID_WORKBOOK", "Excel 在读取过程中发生变化。"),
    "invalid_evidence_id": (400, "INVALID_EVIDENCE_ID", "证据会话 ID 无效。"),
    "evidence_not_found": (404, "EVIDENCE_NOT_FOUND", "证据会话不存在。"),
    "invalid_evidence_bundle": (400, "INVALID_EVIDENCE", "证据包无效。"),
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

    def do_OPTIONS(self) -> None:
        if self.path not in WRITE_ENDPOINTS:
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
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(
                404,
                {"ok": False, "error": "NOT_FOUND", "message": "接口不存在。"},
            )
            return
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
        if self.path == "/analyze-path":
            self._exact_fields(payload, {"path"})
            return service.analyze_path(self._text(payload, "path"))
        if self.path == "/analyze-upload":
            self._exact_fields(payload, {"filename", "contentBase64"})
            filename = self._text(payload, "filename")
            encoded = self._text(payload, "contentBase64")
            try:
                content = base64.b64decode(encoded.encode("ascii"), validate=True)
            except (UnicodeError, ValueError, binascii.Error):
                raise ValueError("invalid_base64") from None
            return service.analyze_upload(filename, content)
        if self.path == "/validate-section":
            self._exact_fields(payload, {"evidenceId", "batch"})
            return service.validate_batch(
                self._text(payload, "evidenceId"),
                payload["batch"],
            )
        if self.path == "/assemble-report":
            self._exact_fields(payload, {"evidenceId", "batches"})
            batches = payload["batches"]
            if not isinstance(batches, list):
                raise ValueError("invalid_batches")
            return cast(
                dict[str, object],
                service.assemble(
                    self._text(payload, "evidenceId"),
                    cast(list[object], batches),
                ),
            )
        raise ValueError("unknown_endpoint")

    def do_POST(self) -> None:
        if self.path not in WRITE_ENDPOINTS:
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
            if str(error).split(":", 1)[0] == "invalid_base64":
                self._send_json(
                    400,
                    {
                        "ok": False,
                        "error": "INVALID_BASE64",
                        "message": "contentBase64 不是有效的 Base64。",
                    },
                    origin=self._origin(),
                )
                return
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
