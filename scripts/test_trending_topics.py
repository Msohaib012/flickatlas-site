import importlib.util
import json
import os
import tempfile
import unittest
import sys
import types
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.modules['step_runs'] = types.SimpleNamespace(record=lambda *a, **k: None)
spec = importlib.util.spec_from_file_location("trending_weekly", os.path.join(HERE, "trending_weekly.py"))
tw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tw)

class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None): return cls(2026, 10, 29, 12, tzinfo=timezone.utc)

class TrendingEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
        self.related = [{"title":"Jailer 2 release and box office update", "url":"https://news.example/jailer"}]
        self.item = {"q":"Jailer 2", "traffic":"20K+", "geo":"IN", "trending_started_at":"2026-10-29T08:00:00Z", "observed_at":"2026-10-29T11:00:00Z", "feed_url":tw.FEEDS["IN"], "news":self.related}
        self.article = {"id":"story 1", "headline":"Jailer 2 Box Office Collection", "date":"2026-10-28T12:00:00Z", "_dt":datetime(2026,10,28,12,tzinfo=timezone.utc)}

    def test_intersection_emits_google_proof_and_canonical_link(self):
        got=tw.build_topics([self.item],[self.article],self.now)
        self.assertEqual(len(got),1)
        self.assertEqual(got[0]["title"],self.article["headline"])
        self.assertEqual(got[0]["url"],"/news-item?id=story%201")
        p=got[0]["trend_proof"]
        self.assertEqual((p["source"],p["geo"],p["source_url"]),("google-rss","IN",tw.FEEDS["IN"]))
        self.assertEqual(p["observed_at"],self.item["observed_at"])

    def test_feed_url_geo_and_external_related_required(self):
        for bad in [dict(self.item,feed_url="https://evil.example/rss"),dict(self.item,geo="US"),dict(self.item,news=[dict(self.related[0],url="https://flickatlas.co.uk/news")]),dict(self.item,news=[dict(self.related[0],url="https://flickatlas.com/news")]),dict(self.item,news=[dict(self.related[0],url="https://flickatlas-hidden.hidden-decodes.workers.dev/x")])]:
            self.assertEqual(tw.build_topics([bad],[self.article],self.now),[])

    def test_old_or_future_activity_and_old_trend_rejected(self):
        for patch_item in [dict(self.item,observed_at="2026-10-29T08:59:59Z"),dict(self.item,observed_at="2026-10-29T12:01:00Z"),dict(self.item,trending_started_at="2026-10-28T11:59:59Z"),dict(self.item,trending_started_at="2026-10-29T12:01:00Z")]:
            self.assertEqual(tw.build_topics([patch_item],[self.article],self.now),[])

    def test_strong_term_and_related_context_required(self):
        unrelated=dict(self.article,headline="Today brought news for audiences")
        self.assertEqual(tw.build_topics([self.item],[unrelated],self.now),[])
        weak=dict(self.item,q="movie",news=[{"title":"Jailer update", "url":"https://news.example/x"}])
        self.assertEqual(tw.build_topics([weak],[self.article],self.now),[])
        ambiguous=dict(self.item,q="Jailer",news=[{"title":"Sports score in Jailer town", "url":"https://news.example/x"}])
        self.assertEqual(tw.build_topics([ambiguous],[self.article],self.now),[])

    def test_sort_unique_and_limit(self):
        items=[dict(self.item,q="Jailer 2")]
        arts=[dict(self.article,id="z",date="2026-10-27T12:00:00Z",_dt=self.now-timedelta(days=2)),dict(self.article,id="a",date="2026-10-28T12:00:00Z",_dt=self.now-timedelta(days=1))]
        got=tw.build_topics(items,arts,self.now)
        self.assertEqual([x["article_id"] for x in got],["a","z"])

    def test_reconcile_is_cache_only_checked_at_does_not_advance_and_stale_clears(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root,"out")); os.makedirs(os.path.join(root,"js"))
            cache={"source":"google-rss","status":"ok","checked_at":"2026-10-29T11:00:00Z","items":[self.item]}
            with open(os.path.join(root,"out","google-trends-evidence.json"),"w") as f: json.dump(cache,f)
            data="window.FA_ARTICLES = "+json.dumps([{"id":"story 1","headline":self.article["headline"],"published":"2026-10-28T12:00:00Z"}])+";\n"
            with open(os.path.join(root,"js","articles-data.js"),"w") as f:f.write(data)
            with patch.object(tw,"datetime",FrozenDateTime), patch("urllib.request.urlopen",side_effect=AssertionError("network call forbidden")):
                self.assertEqual(tw.main(["--root",root,"--reconcile-only"]),0)
                with open(os.path.join(root,"js","trending-topics.js")) as f: first=f.read()
                payload=json.loads(first.split(" = ",1)[1].rstrip(";\n"))
                self.assertEqual(payload["checked_at"],cache["checked_at"])
                self.assertEqual(len(payload["topics"]),1)
                cache.update(status="upstream-stale",checked_at="2020-01-01T00:00:00Z",items=[])
                with open(os.path.join(root,"out","google-trends-evidence.json"),"w") as f:json.dump(cache,f)
                tw.main(["--root",root])
                with open(os.path.join(root,"js","trending-topics.js")) as f: cleared=json.loads(f.read().split(" = ",1)[1].rstrip(";\n"))
                self.assertEqual(cleared["topics"],[])
                self.assertEqual(cleared["status"],"stale")
                self.assertEqual(cleared["checked_at"],cache["checked_at"])

if __name__ == "__main__": unittest.main()
