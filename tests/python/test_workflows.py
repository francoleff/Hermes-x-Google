"""Cross-app workflows: parsing, previews that must not write, and conflict detection."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fakes import FakeResponse, gmail_message, gmail_router

from hermes_google_workspace import workflows
from hermes_google_workspace.client import WorkspaceError


# ── Parsing helpers ──────────────────────────────────────────────────────────


def test_when_parser_reads_day_month_and_time(cet):
    reference = datetime(2026, 11, 6, 9, 0, tzinfo=cet)
    parsed = workflows._parse_when("Let's meet on 12 Nov at 3pm to review", reference)
    assert parsed == datetime(2026, 11, 12, 15, 0, tzinfo=cet)


def test_when_parser_returns_none_rather_than_guessing(cet):
    assert workflows._parse_when("Lunch sometime soon", datetime(2026, 11, 6, tzinfo=cet)) is None


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Invoice total: EUR 1.234,56", ("EUR", "1234.56")),
        ("Invoice total EUR 1.234,56", ("EUR", "1234.56")),
        ("Amount due $99.50", ("$", "99.50")),
        ("Total €1,234.00", ("€", "1234.00")),
        ("Thanks for your order", ("", "")),
    ],
)
def test_amount_parser_reads_european_and_us_formats(text, expected):
    assert workflows._parse_amount(text) == expected


# ── Email to calendar ────────────────────────────────────────────────────────


def test_email_to_event_proposal_flags_calendar_conflicts(google, cet):
    message = gmail_message(
        "m2",
        subject="Re: Can we meet 12 Nov at 3pm?",
        sender="Sarah <sarah@acme.test>",
        body="Could we meet on 12 Nov at 3pm to review the proposal?",
        internal_date_ms=int(datetime(2026, 11, 6, 9, tzinfo=timezone.utc).timestamp() * 1000),
    )
    base = gmail_router(message)

    def route(method, url, body):
        if "/calendar/v3/calendars/primary/events" in url:
            return FakeResponse(
                200,
                {
                    "items": [
                        {
                            "id": "e9",
                            "summary": "Board prep",
                            "status": "confirmed",
                            "start": {"dateTime": "2026-11-12T15:30:00+01:00"},
                            "end": {"dateTime": "2026-11-12T16:30:00+01:00"},
                        }
                    ]
                },
            )
        return base(method, url, body)

    google.router = route
    proposal = workflows.email_to_event_proposal("m2", duration_minutes=60)
    assert proposal["proposal"]["start"].startswith("2026-11-12T15:00")
    assert proposal["proposal"]["attendees"] == ["sarah@acme.test"]
    assert proposal["certainty"] == "parsed"
    assert [item["summary"] for item in proposal["conflicts"]] == ["Board prep"]


def test_email_to_event_without_confirm_creates_nothing(google, cet):
    message = gmail_message("m4", subject="Call Friday", sender="Ana <ana@acme.test>", body="Let's talk.")
    google.router = gmail_router(message)
    result = workflows.email_to_event("m4", confirm=False)
    assert result["created"] is False
    assert set(google.methods()) == {"GET"}


# ── Invoices ─────────────────────────────────────────────────────────────────


def test_invoice_preview_reads_mail_and_writes_nothing(google, cet):
    message = gmail_message(
        "m3",
        subject="Invoice 42 total EUR 1.234,56",
        sender="Billing <billing@acme.test>",
        body="Thanks. Amount due EUR 1.234,56 by 30 Nov.",
        attachment="invoice-42.pdf",
    )
    google.router = gmail_router(message)
    result = workflows.invoices_to_sheet(query="", days=30, max_results=5, confirm=False)
    assert result["found"] == 1
    row = result["rows"][0]
    assert (row["amount"], row["currency"], row["file"]) == ("1234.56", "EUR", "invoice-42.pdf")
    assert result["created"] is False
    assert set(google.methods()) == {"GET"}


def test_invoice_rows_never_invent_a_missing_amount(google, cet):
    message = gmail_message(
        "m5",
        subject="Your receipt",
        sender="Shop <orders@shop.test>",
        body="Thanks for shopping with us.",
        attachment="receipt.pdf",
    )
    google.router = gmail_router(message)
    result = workflows.invoices_to_sheet(query="", days=30, max_results=5, confirm=False)
    assert result["rows"][0]["amount"] == ""
    assert result["rows"][0]["currency"] == ""


def test_invoice_append_skips_invoices_already_in_the_sheet(google, cet):
    message = gmail_message(
        "m9",
        subject="Invoice 9 total EUR 10,00",
        sender="Billing <billing@acme.test>",
        body="Amount due EUR 10,00",
        attachment="invoice-9.pdf",
    )
    mail = gmail_router(message)
    link = "https://mail.google.com/mail/u/0/#all/m9"

    def route(method, url, body):
        if method == "GET" and "/values/" in url:
            return FakeResponse(
                200,
                {
                    "range": "Invoices!A1:G2",
                    "values": [
                        ["Date", "From", "Subject", "Amount", "Currency", "Attachment", "Link"],
                        ["2026-11-02", "Billing", "Invoice 9", "10.00", "EUR", "invoice-9.pdf", link],
                    ],
                },
            )
        if method == "GET" and "/spreadsheets/s9" in url:
            return FakeResponse(
                200,
                {
                    "spreadsheetId": "s9",
                    "properties": {"title": "Invoices"},
                    "sheets": [{"properties": {"title": "Invoices", "gridProperties": {"rowCount": 1000}}}],
                },
            )
        return mail(method, url, body)

    google.router = route
    result = workflows.invoices_to_sheet(spreadsheet_id="s9", query="", days=30, max_results=5, confirm=True)
    assert result["found"] == 1
    assert result["skipped"] == 1
    assert result["created"] is False
    assert "POST" not in google.methods()


def test_invoice_append_writes_only_new_invoices(google, cet):
    old = gmail_message("m10", subject="Invoice 10 total EUR 5,00", sender="A <a@acme.test>",
                        body="Amount due EUR 5,00", attachment="old.pdf")
    new = gmail_message("m11", subject="Invoice 11 total EUR 7,50", sender="B <b@acme.test>",
                        body="Amount due EUR 7,50", attachment="new.pdf")
    mail = gmail_router(old, new)
    link_old = "https://mail.google.com/mail/u/0/#all/m10"

    def route(method, url, body):
        if method == "GET" and "/values/" in url:
            return FakeResponse(200, {"values": [
                ["Date", "From", "Subject", "Amount", "Currency", "Attachment", "Link"],
                ["2026-11-02", "A", "Invoice 10", "5.00", "EUR", "old.pdf", link_old],
            ]})
        if method == "GET" and "/spreadsheets/s9" in url:
            return FakeResponse(200, {
                "spreadsheetId": "s9", "properties": {"title": "Invoices"},
                "sheets": [{"properties": {"title": "Invoices", "gridProperties": {"rowCount": 1000}}}],
            })
        if method == "POST" and ":append" in url:
            return FakeResponse(200, {"updates": {"updatedRange": "Invoices!A3:G3", "updatedRows": 1,
                                                  "updatedCells": 7}})
        return mail(method, url, body)

    google.router = route
    result = workflows.invoices_to_sheet(spreadsheet_id="s9", query="", days=30, max_results=5, confirm=True)
    assert result["skipped"] == 1
    assert result["created"] is True
    appended = [body for method, url, body in google.calls if method == "POST"]
    assert len(appended) == 1
    rows = appended[0]["values"]
    assert len(rows) == 1
    assert rows[0][5] == "new.pdf"


# ── Drive organisation ───────────────────────────────────────────────────────


def test_organize_preview_moves_nothing(google):
    def route(method, url, body):
        if "drive/v3/files" in url:
            return FakeResponse(
                200,
                {"files": [{"id": "f1", "name": "Plan.pdf", "mimeType": "application/pdf", "parents": ["root"]}]},
            )
        return FakeResponse(200, {})

    google.router = route
    plan = workflows.organize_drive(query="plan", folder_name="Projects", confirm=False)
    assert plan["count"] == 1
    assert plan["created"] is False
    assert set(google.methods()) == {"GET"}


def test_organize_refuses_an_empty_query(google):
    with pytest.raises(WorkspaceError) as caught:
        workflows.organize_drive(query="  ", folder_name="Projects", confirm=True)
    assert caught.value.code == "bad_request"
    assert google.calls == []


# ── Meeting brief ────────────────────────────────────────────────────────────


def test_meeting_brief_gathers_threads_files_and_agenda(google, cet):
    event = {
        "id": "ev1",
        "summary": "Q4 pricing review",
        "status": "confirmed",
        "start": {"dateTime": "2026-11-12T10:00:00+01:00"},
        "end": {"dateTime": "2026-11-12T11:00:00+01:00"},
        "attendees": [
            {"email": "me@example.com", "self": True},
            {"email": "james@acme.test", "displayName": "James", "responseStatus": "accepted"},
        ],
        "description": "Agree pricing\nReview discounts",
    }
    message = gmail_message("m7", subject="Re: pricing deck", sender="James <james@acme.test>", body="Here is the deck.")
    mail = gmail_router(message)

    def route(method, url, body):
        if "/calendar/v3/calendars/primary/events/ev1" in url:
            return FakeResponse(200, event)
        if "/drive/v3/files" in url:
            return FakeResponse(
                200,
                {
                    "files": [
                        {
                            "id": "d1",
                            "name": "Pricing notes",
                            "mimeType": "application/vnd.google-apps.document",
                            "webViewLink": "https://docs.google.com/document/d/d1/edit",
                        }
                    ]
                },
            )
        return mail(method, url, body)

    google.router = route
    brief = workflows.meeting_brief(event_id="ev1", days=14)
    assert brief["event"]["summary"] == "Q4 pricing review"
    assert [person["email"] for person in brief["attendees"]] == ["james@acme.test"]
    assert brief["evidence"]["gmailThreads"] >= 1
    assert brief["relatedFiles"][0]["name"] == "Pricing notes"
    assert "Agree pricing" in brief["suggestedAgenda"]
    markdown = workflows.brief_markdown(brief)
    assert "## Attendees (1)" in markdown
    assert "## Recent threads" in markdown
    assert set(google.methods()) == {"GET"}
