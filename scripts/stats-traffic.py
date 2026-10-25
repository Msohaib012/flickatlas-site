#!/usr/bin/env python3
"""Build js/stats-traffic.json — the traffic half of the FlickAtlas stats page.

Pulls Google Analytics 4 (Data API + Realtime API) every 15 minutes:
  - active users right now (Realtime API)
  - users / pageviews / avg. session today and last 7 days
  - top pages (views + avg. time), sources, countries, devices
  - per-post views + top source, keyed by page path, so the posts table
    can show views for every published article/title

NO GA4 credentials -> writes {"connected": false} and exits 0, never fails.
A GA4 error with credentials present -> writes {"connected": false,
"error": ...} so the page shows the failure instead of fake numbers.

Credentials only from env (repo secrets, set by the owner):
  GA4_PROPERTY_ID          numeric GA4 property id, e.g. 123456789
  GA4_SERVICE_ACCOUNT_JSON the service-account JSON key (whole file contents)

Usage: stats-traffic.py
Needs: pip install google-analytics-data (the workflow does this).
Exits 0 in every case; writes js/stats-traffic.json only when changed.
"""
import json
import os
import sys
from datetime import datetime, timezone


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_out(data):
    out_path = os.path.join(ROOT, "js", "stats-traffic.json")
    # Compare WITHOUT the generated timestamp: the file changes only when
    # the DATA changes. (Every commit to main triggers a Vercel deploy, so
    # a timestamp-only commit every 15 minutes would burn the deploy
    # budget for nothing.)
    existing = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                existing = json.load(f)
        except ValueError:
            existing = {}
    old = {k: v for k, v in existing.items() if k != "generated"}
    new = {k: v for k, v in data.items() if k != "generated"}
    if old != new:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        print(f"stats-traffic: wrote {out_path} (changed)")
    else:
        print("stats-traffic: no change")


def not_connected(reason=None):
    data = {"connected": False, "generated": iso_now()}
    if reason:
        data["error"] = str(reason)[:300]
    write_out(data)
    print(f"stats-traffic: not connected ({reason or 'no GA4 credentials'})")
    return 0


def _num(row, i):
    try:
        return float(row.metric_values[i].value)
    except (IndexError, ValueError, AttributeError):
        return 0.0


def _int(row, i):
    return int(round(_num(row, i)))


def main():
    property_id = (os.environ.get("GA4_PROPERTY_ID") or "").strip()
    sa_json = (os.environ.get("GA4_SERVICE_ACCOUNT_JSON") or "").strip()
    if not property_id or not sa_json:
        return not_connected("GA4_PROPERTY_ID / GA4_SERVICE_ACCOUNT_JSON not set")

    try:
        import json as _json
        from google.analytics.data_v1beta import BetaAnalyticsDataClient
        from google.analytics.data_v1beta.types import (
            DateRange, Dimension, Filter, FilterExpression,
            FilterExpressionList, Metric, RunRealtimeReportRequest,
            RunReportRequest)
        from google.oauth2 import service_account
    except ImportError as e:
        return not_connected(f"google-analytics-data not installed: {e}")

    try:
        info = _json.loads(sa_json)
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/analytics.readonly"])
    except (ValueError, KeyError) as e:
        return not_connected(f"bad GA4_SERVICE_ACCOUNT_JSON: {e}")

    prop = f"properties/{property_id}"
    try:
        client = BetaAnalyticsDataClient(credentials=creds)

        # ---- realtime: users active now ----
        rt = client.run_realtime_report(RunRealtimeReportRequest(
            property=prop, metrics=[Metric(name="activeUsers")]))
        active_now = _int(rt.rows[0], 0) if rt.rows else 0

        def report(dims, metrics, start, end, limit=10, order=None):
            req = RunReportRequest(
                property=prop,
                dimensions=[Dimension(name=d) for d in dims],
                metrics=[Metric(name=m) for m in metrics],
                date_ranges=[DateRange(start_date=start, end_date=end)],
                limit=limit)
            if order:
                req.order_bys = order
            return client.run_report(req)

        from google.analytics.data_v1beta.types import OrderBy
        desc_views = [OrderBy(metric=OrderBy.MetricOrderBy(metric_name="screenPageViews"),
                              desc=True)]

        # ---- totals: today + last 7 days ----
        def totals(start, end):
            r = report([], ["activeUsers", "screenPageViews", "sessions",
                            "averageSessionDuration"], start, end, limit=1)
            if not r.rows:
                return {"users": 0, "pageviews": 0, "sessions": 0,
                        "avg_session_seconds": 0}
            row = r.rows[0]
            return {"users": _int(row, 0), "pageviews": _int(row, 1),
                    "sessions": _int(row, 2),
                    "avg_session_seconds": round(_num(row, 3), 1)}

        today = totals("today", "today")
        last7 = totals("7daysAgo", "today")

        # ---- top pages (7d) ----
        top_pages = []
        r = report(["pagePath", "pageTitle"],
                   ["screenPageViews", "averageSessionDuration"],
                   "7daysAgo", "today", limit=10, order=desc_views)
        for row in r.rows:
            top_pages.append({
                "path": row.dimension_values[0].value,
                "title": row.dimension_values[1].value,
                "views": _int(row, 0),
                "avg_time_seconds": round(_num(row, 1), 1),
            })

        # ---- sources (7d) ----
        sources = []
        r = report(["sessionSource", "sessionMedium"],
                   ["sessions", "activeUsers"], "7daysAgo", "today", limit=10)
        for row in sorted(r.rows, key=lambda x: -_num(x, 0)):
            sources.append({
                "source": row.dimension_values[0].value,
                "medium": row.dimension_values[1].value,
                "sessions": _int(row, 0),
                "users": _int(row, 1),
            })

        # ---- countries (7d) ----
        countries = []
        r = report(["country"], ["activeUsers"], "7daysAgo", "today", limit=10)
        for row in sorted(r.rows, key=lambda x: -_num(x, 0)):
            countries.append({"country": row.dimension_values[0].value,
                              "users": _int(row, 0)})

        # ---- devices (7d) ----
        devices = []
        r = report(["deviceCategory"], ["activeUsers"],
                   "7daysAgo", "today", limit=10)
        for row in sorted(r.rows, key=lambda x: -_num(x, 0)):
            devices.append({"device": row.dimension_values[0].value,
                            "users": _int(row, 0)})

        # ---- per-post views + top source (7d) ----
        # Only detail pages: /news-item?id=, /movie?id=, /show?id=
        path_filter = FilterExpression(or_group=FilterExpressionList(
            expressions=[
                FilterExpression(filter=Filter(
                    field_name="pagePath",
                    string_filter=Filter.StringFilter(
                        match_type=Filter.StringFilter.MatchType.CONTAINS,
                        value="/news-item?id="))),
                FilterExpression(filter=Filter(
                    field_name="pagePath",
                    string_filter=Filter.StringFilter(
                        match_type=Filter.StringFilter.MatchType.CONTAINS,
                        value="/movie?id="))),
                FilterExpression(filter=Filter(
                    field_name="pagePath",
                    string_filter=Filter.StringFilter(
                        match_type=Filter.StringFilter.MatchType.CONTAINS,
                        value="/show?id="))),
            ]))
        r = client.run_report(RunReportRequest(
            property=prop,
            dimensions=[Dimension(name="pagePath"),
                        Dimension(name="sessionSource")],
            metrics=[Metric(name="screenPageViews")],
            date_ranges=[DateRange(start_date="7daysAgo", end_date="today")],
            dimension_filter=path_filter,
            limit=1000))
        per_post = {}
        for row in r.rows:
            path = row.dimension_values[0].value
            src = row.dimension_values[1].value or "(direct)"
            views = _int(row, 0)
            slot = per_post.setdefault(path, {"views": 0, "sources": {}})
            slot["views"] += views
            slot["sources"][src] = slot["sources"].get(src, 0) + views
        per_post = {p: {"views": v["views"],
                        "top_source": max(v["sources"], key=v["sources"].get)}
                    for p, v in per_post.items()}

    except Exception as e:  # GA4 API failure: never fake numbers, never crash
        return not_connected(f"GA4 API error: {e}")

    data = {
        "connected": True,
        "generated": iso_now(),
        "realtime": {"active_users": active_now},
        "today": today,
        "last7": last7,
        "top_pages": top_pages,
        "sources": sources,
        "countries": countries,
        "devices": devices,
        "per_post": per_post,
    }
    write_out(data)
    print(f"stats-traffic: connected, active_now={active_now}, "
          f"today_users={today['users']}, top_pages={len(top_pages)}, "
          f"per_post={len(per_post)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
