from datetime import datetime
from pathlib import Path
import sys
import unittest


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from metrics import parse_metric, parse_publish_time


class ParseMetricTests(unittest.TestCase):
    def test_normalizes_supported_metric_values(self) -> None:
        cases = {
            "1.5w": 15000,
            "1.5W": 15000,
            "1.5万": 15000,
            "8,000": 8000,
            8000: 8000,
            None: 0,
            "无法识别": 0,
            -5: 0,
        }

        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                actual, _warnings = parse_metric(raw)
                self.assertEqual(actual, expected)

    def test_warns_for_negative_and_unrecognized_metrics(self) -> None:
        _value, negative_warnings = parse_metric(-5)
        _value, unrecognized_warnings = parse_metric("无法识别")

        self.assertIn("negative_metric", negative_warnings)
        self.assertIn("unrecognized_metric", unrecognized_warnings)


class ParsePublishTimeTests(unittest.TestCase):
    def test_supports_datetime_excel_serial_timestamps_and_fixed_formats(self) -> None:
        cases = (
            (datetime(2026, 7, 31, 12, 30), datetime(2026, 7, 31, 12, 30)),
            (1, datetime(1900, 1, 1)),
            (1_722_429_000, datetime(2024, 7, 31, 12, 30)),
            (1_722_429_000_000, datetime(2024, 7, 31, 12, 30)),
            ("2026-07-31 12:30:15", datetime(2026, 7, 31, 12, 30, 15)),
            ("2026-07-31 12:30", datetime(2026, 7, 31, 12, 30)),
        )

        for raw, expected in cases:
            with self.subTest(raw=raw):
                actual, warnings = parse_publish_time(raw)
                self.assertEqual(actual, expected)
                self.assertEqual(warnings, [])

    def test_returns_warning_for_invalid_publish_time(self) -> None:
        actual, warnings = parse_publish_time("not-a-time")

        self.assertIsNone(actual)
        self.assertIn("invalid_publish_time", warnings)
