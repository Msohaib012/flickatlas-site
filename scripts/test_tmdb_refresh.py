#!/usr/bin/env python3
"""Mock-only regression tests for global and digital TMDB refreshes."""
import importlib.util, json, os, sys, tempfile, types
from datetime import date, datetime, timezone
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
def load(name,file):
 s=importlib.util.spec_from_file_location(name,os.path.join(HERE,file)); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
sys.modules['step_runs']=types.SimpleNamespace(record=lambda *a,**k: None)
ts=load('title_seed_test','title-seed.py'); ott=load('build_ott_test','build_ott.py')
passn=0
def check(name, condition):
 global passn
 if not condition: raise AssertionError(name)
 passn+=1

# source recorder mock
records=[]
sched=types.ModuleType('pipeline_schedule'); sched.record_source=lambda *a,**k: records.append((a,k)); sched.source_due=lambda *a,**k: True
sys.modules['pipeline_schedule']=sched
with tempfile.TemporaryDirectory() as d:
 old=ts.tmdb_get
 results=[{'id':i,'poster_path':'/p'} for i in range(1,26)]
 results[0]['poster_path']=None
 ts.tmdb_get=lambda *a: {'results':results}
 ts.refresh_trending('x',d)
 txt=open(os.path.join(d,'trending-data.js')).read()
 ids=json.loads(txt.split('window.FA_TRENDING = ')[1].split(';')[0])
 check('global first20 before poster filtering and preserve rank',ids==list(range(2,21)))
 check('valid snapshot records success',records[-1][0][0:2]==('trending_worldwide',True))
 prior=txt
 ts.refresh_trending('x',d)
 check('unchanged snapshot still succeeds',records[-1][0][1] is True and open(os.path.join(d,'trending-data.js')).read()==prior)
 ts.tmdb_get=lambda *a: {'results':[]}
 ts.refresh_trending('x',d)
 check('global empty preserves last-good snapshot',open(os.path.join(d,'trending-data.js')).read()==prior)
 check('empty records failure',records[-1][0][1] is False)
 before=len(records); ts.tmdb_get=lambda *a: {'results':results}; ts.refresh_trending('x',d,True)
 check('trending dry-run does not record',len(records)==before)
 ts.tmdb_get=old

# TTL uses strict UTC parsing; cache-only never invokes TMDB.
with tempfile.TemporaryDirectory() as d:
 cache=os.path.join(d,'cache.json')
 json.dump({'fetched_at':datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'days':30,'digital':{'1':{'date':'2027-01-01','country':'US','note':'Netflix'}},'registry':{}},open(cache,'w'))
 oldget=ott.tmdb_get; ott.tmdb_get=lambda *a: (_ for _ in ()).throw(AssertionError('unexpected TMDB'))
 val=ott.fetch_digital({},'key',date.today(),30,cache,cached_only=True)
 check('cached-only reads even expired cache without network',val[0].get('1') is not None)
 oldttl=ott.CACHE_TTL_SEC; ott.CACHE_TTL_SEC=999999
 class Clock(datetime):
  @classmethod
  def now(cls,tz=None): return datetime(2026,10,29,12,30,0,tzinfo=timezone.utc)
 olddt=ott.datetime; ott.datetime=Clock
 cache_obj=json.load(open(cache)); cache_obj['fetched_at']='2026-10-29T00:00:00Z'; json.dump(cache_obj,open(cache,'w'))
 check('mocked UTC cache younger than 12h recognized',ott.fetch_digital({},'key',date.today(),30,cache)[0].get('1') is not None)
 cache_obj['fetched_at']='2026-10-28T23:59:59Z'; json.dump(cache_obj,open(cache,'w')); ott.CACHE_TTL_SEC=12*3600
 check('mocked UTC cache older than 12h expires',ott._read_digital_cache(cache,30)[1]>=ott.CACHE_TTL_SEC)
 ott.datetime=olddt; ott.CACHE_TTL_SEC=oldttl
 ott.tmdb_get=oldget

# Mock complete refresh and partial failure/429 preserve cache. Empty arrays are valid.
with tempfile.TemporaryDirectory() as d:
 cache=os.path.join(d,'c.json'); old_cache={'fetched_at':'2020-01-01T00:00:00Z','days':30,'digital':{'old':{'date':'2027-01-01','country':'US','note':''}},'registry':{'Keep':'/old'}}
 json.dump(old_cache,open(cache,'w')); records.clear()
 calls=[]
 def good(path,key):
  calls.append(path)
  if path=='/watch/providers/movie': return {'results':[]}
  return {'results':[]}
 ott.tmdb_get=good
 dig,reg=ott.fetch_digital({'a':{'id':1,'type':'movie'}},'k',date.today(),30,cache,refresh=True)
 fresh=json.load(open(cache)); check('valid empty response refresh succeeds',fresh['digital']=={} and fresh['registry']=={})
 check('successful empty refresh recorded',records[-1][0][1] is True)
 json.dump(old_cache,open(cache,'w')); records.clear()
 def fail(path,key):
  if path=='/watch/providers/movie': return {'results':[]}
  raise Exception('429 Too Many Requests')
 ott.tmdb_get=fail
 got=ott.fetch_digital({'a':{'id':1,'type':'movie'},'b':{'id':2,'type':'movie'}},'k',date.today(),30,cache,refresh=True)
 check('partial failure returns cached prior',got[0]==old_cache['digital'])
 check('partial failure keeps last-good file untouched',json.load(open(cache))==old_cache)
 check('429 failure recorded',records[-1][0][1] is False)
 ott.tmdb_get=oldget

# TV classification fails closed on old first_air_date, allows genuinely recent provider-listed TV.
today='2026-10-29'
pub={'old':{'id':1,'type':'tv','first_air_date':'2020-01-01','providers':[{'name':'Netflix'}]},'recent':{'id':2,'type':'tv','first_air_date':'2026-10-20','providers':[{'name':'Netflix'}]},'movie':{'id':3,'type':'movie','release_date':'2026-11-05','providers':[{'name':'Netflix'}]}}
now,coming,_=ott.classify(pub,today)
check('old popular TV excluded from Now',all(x['id']!=1 for x in now))
check('recent provider-listed TV may enter Now',any(x['id']==2 for x in now))
check('future movie remains confirmed dated Coming',any(x['id']==3 and x['date']=='2026-11-05' for x in coming))
check('coming dates ascending', [x['date'] for x in coming]==sorted(x['date'] for x in coming))
print(f'PASS: {passn} TMDB refresh tests')
