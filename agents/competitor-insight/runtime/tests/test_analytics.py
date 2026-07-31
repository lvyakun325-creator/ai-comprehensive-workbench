from datetime import datetime, timedelta
from pathlib import Path
import sys
import unittest


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from analytics import calculate_metrics, rank_works


class AnalyticsTests(unittest.TestCase):
    def _works(self, count: int) -> list[dict[str, object]]:
        start = datetime(2026, 1, 1)
        return [
            {
                "sourceRow": index,
                "title": f"作品 {index}",
                "likes": index + 1,
                "comments": index + 10,
                "collects": index + 20,
                "shares": index + 30,
                "publishedAt": (start + timedelta(days=index)).isoformat(),
                "url": "",
            }
            for index in range(count)
        ]

    def test_ranks_overall_and_each_specific_metric_with_stable_ties(self) -> None:
        works = [
            {"sourceRow": 0, "likes": 30, "comments": 1, "collects": 10, "shares": 0, "publishedAt": "2026-01-02T00:00:00"},
            {"sourceRow": 1, "likes": 6, "comments": 5, "collects": 9, "shares": 6, "publishedAt": "2026-01-01T00:00:00"},
            {"sourceRow": 2, "likes": 30, "comments": 2, "collects": 8, "shares": 5, "publishedAt": "2026-01-03T00:00:00"},
            {"sourceRow": 3, "likes": 0, "comments": 3, "collects": 7, "shares": 9, "publishedAt": "2026-01-04T00:00:00"},
            {"sourceRow": 4, "likes": 0, "comments": 4, "collects": 6, "shares": 8, "publishedAt": "2026-01-05T00:00:00"},
            {"sourceRow": 5, "likes": 0, "comments": 6, "collects": 5, "shares": 7, "publishedAt": "2026-01-06T00:00:00"},
        ]

        rankings = rank_works(works, {"comments": True, "collects": True, "shares": True})

        self.assertEqual(rankings["overall"]["rows"][:3], [2, 0, 1])
        self.assertEqual(rankings["collect"]["rows"], [0, 1, 2, 3, 4])
        self.assertEqual(rankings["share"]["rows"], [3, 4, 5, 1, 2])
        self.assertEqual(rankings["comment"]["rows"], [5, 1, 4, 3, 2])

    def test_startup_window_rules_exclude_missing_dates_and_select_top_five(self) -> None:
        for count, expected_window_size in ((8, 5), (20, 5), (21, 6), (40, 10)):
            with self.subTest(count=count):
                works = self._works(count)
                works[-1]["publishedAt"] = None
                rankings = rank_works(works, {"comments": True, "collects": True, "shares": True})

                self.assertEqual(len(rankings["startup"]["sampleRows"]), expected_window_size)
                self.assertNotIn(count - 1, rankings["startup"]["sampleRows"])
                self.assertLessEqual(len(rankings["startup"]["rows"]), 5)

    def test_startup_prefers_early_high_performers_then_fills_by_interactions(self) -> None:
        works = self._works(8)
        for index, work in enumerate(works):
            work["likes"] = 1
            work["comments"] = 0
            work["collects"] = 0
            work["shares"] = 0
        works[1]["likes"] = 50
        works[3]["likes"] = 40
        works[6]["likes"] = 1_000
        works[7]["publishedAt"] = None

        rankings = rank_works(works, {"comments": True, "collects": True, "shares": True})

        self.assertEqual(rankings["startup"]["rows"][:2], [1, 3])
        self.assertEqual(len(rankings["startup"]["rows"]), 5)

    def test_marks_unavailable_specific_rankings_without_rows(self) -> None:
        rankings = rank_works(self._works(8), {"comments": False, "collects": False, "shares": False})

        for name in ("collect", "share", "comment"):
            self.assertEqual(rankings[name]["status"], "unavailable")
            self.assertEqual(rankings[name]["rows"], [])

    def test_calculates_summary_metrics_and_returns_none_for_zero_denominator(self) -> None:
        works = self._works(3)
        rankings = rank_works(works, {"comments": True, "collects": True, "shares": True})

        metrics = calculate_metrics(works, rankings)

        self.assertEqual(metrics["workCount"], 3)
        self.assertEqual(metrics["top10InteractionShare"], 1.0)
        self.assertGreater(metrics["maxToAverageMultiple"], 1.0)

        zero_works = self._works(2)
        for work in zero_works:
            for field in ("likes", "comments", "collects", "shares"):
                work[field] = 0
        zero_metrics = calculate_metrics(
            zero_works,
            rank_works(zero_works, {"comments": True, "collects": True, "shares": True}),
        )
        self.assertIsNone(zero_metrics["top10InteractionShare"])
        self.assertIsNone(zero_metrics["maxToAverageMultiple"])


if __name__ == "__main__":
    unittest.main()
