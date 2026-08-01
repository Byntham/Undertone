"""Desktop-independent tests for UIA caret range handling."""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import caretctx  # noqa: E402


class FakeRange:
    def __init__(self, text, start, end):
        self.text = text
        self.start = start
        self.end = end

    def Clone(self):
        return FakeRange(self.text, self.start, self.end)

    def MoveEndpointByUnit(self, endpoint, _unit, count):
        if endpoint == UIA.TextPatternRangeEndpoint_Start:
            self.start = max(0, min(len(self.text), self.start + count))
        else:
            self.end = max(0, min(len(self.text), self.end + count))

    def CompareEndpoints(self, endpoint, other, other_endpoint):
        left = self.start if endpoint == UIA.TextPatternRangeEndpoint_Start \
            else self.end
        right = other.start \
            if other_endpoint == UIA.TextPatternRangeEndpoint_Start \
            else other.end
        return (left > right) - (left < right)

    def MoveEndpointByRange(self, endpoint, other, other_endpoint):
        value = other.start \
            if other_endpoint == UIA.TextPatternRangeEndpoint_Start \
            else other.end
        if endpoint == UIA.TextPatternRangeEndpoint_Start:
            self.start = value
        else:
            self.end = value

    def GetText(self, _max_length):
        return self.text[self.start:self.end]


class FakeCollection:
    def __init__(self, selected):
        self.selected = selected
        self.Length = 1

    def GetElement(self, _index):
        return self.selected


class FakeRaw:
    def __init__(self, pattern):
        self.pattern = pattern

    def QueryInterface(self, _interface):
        return self.pattern


class FakeTextPattern2:
    def __init__(self, caret):
        self.caret = caret

    def GetCaretRange(self):
        return True, self.caret


class FakeTextPattern:
    def __init__(self, selected):
        self.selected = selected

    def GetSelection(self):
        return FakeCollection(self.selected)


class FakeValuePattern:
    def __init__(self, value):
        self.CurrentValue = value


class FakeElement:
    CurrentIsPassword = False

    def __init__(self, caret, selected):
        self.patterns = {
            UIA.UIA_TextPattern2Id: FakeRaw(FakeTextPattern2(caret)),
            UIA.UIA_TextPatternId: FakeRaw(FakeTextPattern(selected)),
        }

    def GetCurrentPattern(self, pattern_id):
        return self.patterns[pattern_id]


class FakeAutomation:
    def __init__(self, element):
        self.element = element

    def GetFocusedElement(self):
        return self.element


UIA = SimpleNamespace(
    UIA_TextPattern2Id=2,
    UIA_TextPatternId=1,
    UIA_ValuePatternId=3,
    IUIAutomationTextPattern2=object(),
    IUIAutomationTextPattern=object(),
    IUIAutomationValuePattern=object(),
    TextPatternRangeEndpoint_Start=0,
    TextPatternRangeEndpoint_End=1,
    TextUnit_Character=0,
)


def context(text, caret, selection=None, before_n=120, after_n=120):
    selected = selection or (caret, caret)
    element = FakeElement(
        FakeRange(text, caret, caret),
        FakeRange(text, selected[0], selected[1]),
    )
    return caretctx._query_caret_context(
        UIA, FakeAutomation(element), before_n, after_n)


def test_caret_sides():
    assert context("I like apples.", 7) == ("I like ", "apples.")
    assert context("I like apples.", 7, before_n=5, after_n=6) == \
        ("like ", "apples")
    assert context("I like apples.", 0) == ("", "I like apples.")
    assert context("I like apples.", 14) == ("I like apples.", "")


def test_selection_is_excluded():
    # Pasting replaces "like", so context begins before and resumes after it.
    assert context("I like apples.", 6, selection=(2, 6)) == \
        ("I ", " apples.")


def test_value_pattern_proves_empty():
    class ValueElement:
        CurrentIsPassword = False

        def __init__(self, value):
            self.value = value

        def GetCurrentPattern(self, pattern_id):
            if pattern_id == UIA.UIA_ValuePatternId:
                return FakeRaw(FakeValuePattern(self.value))
            return None

    empty = ValueElement("")
    assert caretctx._query_caret_context(
        UIA, FakeAutomation(empty), 120, 120) == ("", "")
    # A non-empty ValuePattern is not enough to locate its caret, and its
    # contents must not be returned as context.
    nonempty = ValueElement("private existing text")
    assert caretctx._query_caret_context(
        UIA, FakeAutomation(nonempty), 120, 120) is None
    password = ValueElement("")
    password.CurrentIsPassword = True
    assert caretctx._query_caret_context(
        UIA, FakeAutomation(password), 120, 120) is None


def main():
    test_caret_sides()
    test_selection_is_excluded()
    test_value_pattern_proves_empty()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
