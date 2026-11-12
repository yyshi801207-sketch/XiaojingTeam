"""Product task activity is retained as JSON without becoming an SDK reply."""
import json
from pathlib import Path

from deepseek_harness import Notification
from deepseek_harness.api import final_response, finish_reason


def test_group_task_activity_preserves_payload_without_reply_or_turn_end() -> None:
    fixture = (
        Path(__file__).resolve().parents[3]
        / "packages/api/katcats-team/tests/expected/sdk-group-task-event.json"
    )
    expected = json.loads(fixture.read_text(encoding="utf-8"))
    notification = Notification("session.event", {"sessionId": "sdk-group-root", "event": expected})
    assert notification.payload["event"] == expected
    assert final_response([expected]) == ""
    assert finish_reason([expected]) is None


def test_group_context_and_review_notice_preserve_evidence_without_reply_or_turn_end() -> None:
    fixture = (
        Path(__file__).resolve().parents[3]
        / "packages/api/katcats-team/tests/expected/sdk-group-context-events.json"
    )
    expected = json.loads(fixture.read_text(encoding="utf-8"))
    notifications = [Notification("session.event", {"sessionId": "sdk-group-reviewer", "event": event})
                     for event in expected]
    assert [notification.payload["event"] for notification in notifications] == expected
    candidate = notifications[2].payload["event"]["data"]["source"]["reviewRequest"]["candidate"]
    assert candidate["sources"] == [{"deliveryId": "sdk-author-delivery", "botId": "maker"}]
    assert candidate["odooOperation"]["companyId"] == 7
    assert candidate["odooOperation"]["method"] == "create"
    assert final_response(expected) == ""
    assert finish_reason(expected) is None


def test_group_finance_welcome_preserves_connection_notice() -> None:
    fixture = (
        Path(__file__).resolve().parents[3]
        / "packages/api/katcats-team/tests/expected/sdk-group-finance-welcome.json"
    )
    expected = json.loads(fixture.read_text(encoding="utf-8"))
    notification = Notification("session.event", {"sessionId": "sdk-group-root", "event": expected})
    assert notification.payload["event"] == expected
    assert final_response([expected]) == ""
    assert finish_reason([expected]) is None
