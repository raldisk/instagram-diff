# tests/test_detect_changes.py
from run_tracker import detect_changes


def find_event(events, username):
    for e in events:
        if e["username"] == username:
            return e
    return None


def test_detect_basic_new_and_removed():
    all_current = {"alice", "bob"}
    snapshot = {
        "alice":   {"type": "Personal Profile", "full_name": "Alice",   "status": "Mutual"},
        "charlie": {"type": "Personal Profile", "full_name": "Charlie", "status": "Follower Only"},
    }
    history    = {}
    status_map = {"alice": "Mutual", "bob": "Follower Only"}

    new_accounts, returned, removed, events = detect_changes(
        all_current, snapshot, history, status_map)

    assert new_accounts == {"bob"}
    assert returned     == set()
    assert removed      == {"charlie"}

    evt_bob = find_event(events, "bob")
    assert evt_bob is not None
    assert evt_bob["event"]      == "New"
    assert evt_bob["new_status"] == "Follower Only"

    evt_charlie = find_event(events, "charlie")
    assert evt_charlie is not None
    assert evt_charlie["event"]      == "Removed"
    assert evt_charlie["old_status"] == "Follower Only"


def test_detect_returned_if_previously_removed():
    all_current = {"bob"}
    snapshot    = {}
    history     = {
        "bob": [{"Date": "2025-01-01", "Username": "bob", "Full Name": "Bob",
                 "Event": "Removed", "Old Status": "Follower Only", "New Status": ""}]
    }
    status_map = {"bob": "Following Only"}

    new_accounts, returned, removed, events = detect_changes(
        all_current, snapshot, history, status_map)

    assert new_accounts == set()
    assert returned     == {"bob"}
    assert removed      == set()

    evt = find_event(events, "bob")
    assert evt is not None
    assert evt["event"]      == "Returned"
    assert evt["old_status"] == "Removed"
    assert evt["new_status"] == "Following Only"


def test_possibly_deactivated_counts_as_previously_removed():
    all_current = {"dave", "eve"}
    snapshot    = {
        "dave":  {"type": "Personal Profile", "full_name": "Dave",  "status": "Mutual"},
        "frank": {"type": "Personal Profile", "full_name": "Frank", "status": "Follower Only"},
    }
    history = {
        "dave": [{"Date": "2024-12-01", "Username": "dave", "Full Name": "Dave",
                  "Event": "Possibly Deactivated", "Old Status": "Mutual", "New Status": ""}]
    }
    status_map = {"dave": "Mutual", "eve": "Follower Only"}

    new_accounts, returned, removed, events = detect_changes(
        all_current, snapshot, history, status_map)

    assert "eve"   in new_accounts
    assert "dave"  not in new_accounts
    assert "frank" in removed

    evt_frank = find_event(events, "frank")
    assert evt_frank is not None
    assert evt_frank["event"] == "Removed"


def test_mutual_disappears_becomes_possibly_deactivated():
    all_current = {"alice"}
    snapshot    = {
        "alice": {"type": "Personal Profile", "full_name": "Alice", "status": "Mutual"},
        "ghost": {"type": "Personal Profile", "full_name": "Ghost", "status": "Mutual"},
    }
    history    = {}
    status_map = {"alice": "Mutual"}

    new_accounts, returned, removed, events = detect_changes(
        all_current, snapshot, history, status_map)

    assert removed == {"ghost"}

    evt_ghost = find_event(events, "ghost")
    assert evt_ghost is not None
    assert evt_ghost["event"] == "Possibly Deactivated"
    assert evt_ghost["old_status"] == "Mutual"


def test_no_changes_returns_empty_sets():
    all_current = {"alice", "bob"}
    snapshot    = {
        "alice": {"type": "Personal Profile", "full_name": "Alice", "status": "Mutual"},
        "bob":   {"type": "Personal Profile", "full_name": "Bob",   "status": "Follower Only"},
    }
    history    = {}
    status_map = {"alice": "Mutual", "bob": "Follower Only"}

    new_accounts, returned, removed, events = detect_changes(
        all_current, snapshot, history, status_map)

    assert new_accounts == set()
    assert returned     == set()
    assert removed      == set()
    assert events       == []
