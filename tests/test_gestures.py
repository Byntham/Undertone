"""Unit tests for the TapStateMachine (no pytest, no audio, no hooks).

Uses shrunken timing windows and real sleeps; each scenario records which
actions fired so gesture outcomes are asserted exactly.
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hotkey import TapStateMachine  # noqa: E402

SHORT = 0.10
DOUBLE = 0.15


def make(start_ok=True):
    actions = []
    sm = TapStateMachine(
        on_start=lambda: (actions.append("start"), start_ok)[1],
        on_finish=lambda: actions.append("finish"),
        on_discard=lambda: actions.append("discard"),
        on_lock=lambda: actions.append("lock"),
        short_tap_s=SHORT, double_tap_s=DOUBLE,
    )
    return sm, actions


def test_hold_and_release_transcribes():
    sm, actions = make()
    sm.press()
    time.sleep(SHORT + 0.05)
    sm.release()
    assert actions == ["start", "finish"], actions
    assert sm.state == sm.IDLE


def test_stray_tap_discards_after_window():
    sm, actions = make()
    sm.press()
    sm.release()                      # instant tap
    assert sm.state == sm.TAP_WAIT
    time.sleep(DOUBLE + 0.08)
    assert actions == ["start", "discard"], actions
    assert sm.state == sm.IDLE


def test_double_tap_locks_then_press_finishes():
    sm, actions = make()
    sm.press(); sm.release()          # tap 1
    time.sleep(DOUBLE / 2)
    sm.press()                        # tap 2 -> locked; on_lock fires ONCE
    assert sm.state == sm.LOCKED
    sm.release()                      # tap 2's release is meaningless
    assert sm.state == sm.LOCKED
    time.sleep(DOUBLE + 0.08)         # no timer may fire while locked
    assert actions == ["start", "lock"], actions
    sm.press()                        # stop press
    assert actions == ["start", "lock", "finish"], actions
    assert sm.state == sm.IDLE
    sm.release()                      # stop press's release: no-op
    assert actions == ["start", "lock", "finish"], actions


def test_slowish_first_tap_still_locks():
    # The review-confirmed bug: hold just under SHORT, then retap. With the
    # gap measured from RELEASE this must lock; press-anchored timing lost
    # the recording.
    sm, actions = make()
    sm.press()
    time.sleep(SHORT * 0.8)           # hold 80% of the short-tap window
    sm.release()
    time.sleep(DOUBLE * 0.7)          # natural retap gap, within window
    sm.press()
    assert sm.state == sm.LOCKED, sm.state
    assert actions == ["start", "lock"], actions


def test_late_second_press_starts_fresh_dictation():
    sm, actions = make()
    sm.press(); sm.release()          # tap 1
    time.sleep(DOUBLE + 0.08)         # window expires -> discard
    sm.press()                        # this is a NEW dictation
    assert actions == ["start", "discard", "start"], actions
    assert sm.state == sm.HELD


def test_toggle_key_round_trip():
    sm, actions = make()
    sm.toggle()                       # start locked; on_lock fires ONCE
    assert sm.state == sm.LOCKED
    assert actions == ["start", "lock"], actions
    sm.toggle()
    assert actions == ["start", "lock", "finish"], actions
    assert sm.state == sm.IDLE


def test_failed_start_stays_idle():
    sm, actions = make(start_ok=False)
    sm.press()
    assert sm.state == sm.IDLE
    sm.release()                      # must not finish anything
    assert actions == ["start"], actions


def test_cancel_from_held_discards_and_release_is_noop():
    # Esc while HELD: discard, and the later physical release must do nothing.
    sm, actions = make()
    sm.press()
    assert sm.cancel() is True
    assert actions == ["start", "discard"], actions
    assert sm.state == sm.IDLE
    sm.release()                      # physical key-up after the cancel
    assert actions == ["start", "discard"], actions
    assert sm.state == sm.IDLE


def test_cancel_in_idle_returns_false():
    sm, actions = make()
    assert sm.cancel() is False
    assert actions == [], actions
    assert sm.state == sm.IDLE


def test_cancel_from_locked_discards():
    sm, actions = make()
    sm.toggle()
    assert sm.state == sm.LOCKED
    assert sm.cancel() is True
    assert actions == ["start", "lock", "discard"], actions
    assert sm.state == sm.IDLE


def test_cancel_from_tap_wait_stops_timer():
    sm, actions = make()
    sm.press(); sm.release()          # instant tap -> TAP_WAIT with timer
    assert sm.cancel() is True
    time.sleep(DOUBLE + 0.08)         # expired timer must not discard again
    assert actions == ["start", "discard"], actions
    assert sm.state == sm.IDLE


def main():
    test_hold_and_release_transcribes()
    test_stray_tap_discards_after_window()
    test_double_tap_locks_then_press_finishes()
    test_slowish_first_tap_still_locks()
    test_late_second_press_starts_fresh_dictation()
    test_toggle_key_round_trip()
    test_failed_start_stays_idle()
    test_cancel_from_held_discards_and_release_is_noop()
    test_cancel_in_idle_returns_false()
    test_cancel_from_locked_discards()
    test_cancel_from_tap_wait_stops_timer()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
