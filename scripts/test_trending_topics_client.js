// Boundary fixtures updated 2026-11-02: the two age-rejection cases now
// sit at 72h+1s (were 24h+1s), matching the aligned client windows
// (PROOF/TREND max age 72h, same as scripts/trending_weekly.py).
const fs=require('fs'), vm=require('vm'), assert=require('assert'), path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','js','trending-searches.js'),'utf8');
const now=Date.parse('2026-10-29T12:00:00Z');
const article={id:'story 1',headline:'Jailer 2 Box Office Collection',published:'2026-10-28T10:00:00Z'};
const proof={source:'google-rss',term:'Jailer 2',geo:'IN',started_at:'2026-10-29T08:00:00Z',observed_at:'2026-10-29T11:00:00Z',source_url:'https://trends.google.com/trending/rss?geo=IN',related:[{title:'Jailer 2 release and box office update',url:'https://news.example/jailer'}]};
const topic={title:article.headline,article_id:article.id,url:'/news-item?id=story%201',trend_proof:proof};
const payload={source:'google-rss',status:'ok',checked_at:'2026-10-29T11:00:00Z',topics:[topic]};
const context={Date:class extends Date{static now(){return now;}},URL,console};context.window=context;vm.runInNewContext(source,context);
const h=context.FATrendingSearches.helpers;
assert.strictEqual(h.validTopics(payload,[article],now).length,1);
assert.strictEqual(h.validTopics({...payload,topics:[{...topic,trend_proof:{...proof,observed_at:'2026-10-29T02:00:00Z'}}]},[article],now).length,1);
// checked_at bound is 24h (fix 2026-11-02): it is the evidence FETCH
// time, not a per-topic freshness gate — a 3h-old payload still renders.
assert.strictEqual(h.validTopics({...payload,checked_at:'2026-10-29T08:59:59Z'},[article],now).length,1);
for(const altered of [
 {...payload,source:'tavily'},
 {...payload,status:'stale'},
 {...payload,checked_at:'2026-10-28T11:59:59Z'},
 {...payload,topics:[{...topic,url:'https://evil.example/'}]},
 {...payload,topics:[{...topic,article_id:'absent'}]},
 {...payload,topics:[{...topic,title:'Unrelated'}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,source_url:'https://evil.example/rss'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,geo:'US'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,observed_at:'2026-10-26T11:59:59Z'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,observed_at:'2026-10-29T12:01:00Z'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,started_at:'2026-10-26T11:59:59Z'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,term:'movie'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,related:[{title:'Jailer sports update',url:'https://flickatlas.co.uk/news'}]}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,related:[{title:'Jailer sports update',url:'https://flickatlas.com/news'}]}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,related:[{title:'Jailer sports update',url:'https://flickatlas-x.hidden-decodes.workers.dev/news'}]}}]}
]) assert.strictEqual(h.validTopics(altered,[article],now).length,0);
assert.strictEqual(h.validTopics(payload,[{...article,published:'2026-10-01T00:00:00Z'}],now).length,0);
// Live regressions (2026-11-02): topics the SERVER emitted from real
// Google feeds that the old client matcher silently dropped, emptying
// the homepage rail on the owner's phone. (1) Term "the avengers":
// the raw phrase never appears in the headline, and the term reduces
// to one subject word whose related headlines carry no entertainment
// keyword — the server passes it via shared>=3. (2) Term "gta vi"
// (AU): the headline spells the franchise out, so the abbreviation
// itself is not a headline word — per-token alias satisfaction.
const avengersArticle={id:'g9harb',headline:'Marvel Studios Unveils Seven New Avengers: Doomsday Posters Highlighting Doctor Doom',published:'2026-10-29T09:00:00Z'};
const avengersProof={source:'google-rss',term:'the avengers',geo:'US',started_at:'2026-10-29T08:00:00Z',observed_at:'2026-10-29T11:00:00Z',source_url:'https://trends.google.com/trending/rss?geo=US',related:[{title:'The Avengers, X-Men & More Marvel Team-Ups Explained',url:'https://www.tvinsider.com/gallery/marvel-team-ups-explained/'},{title:'A Guide to Marvel’s Team-Ups: The Avengers, X-Men, Fantastic Four & More Explained',url:'https://www.cadillacnews.com/entertainment/a-guide-to-marvels-team-ups/'},{title:'Spider-Man Defies the Avengers to Take on Marvel’s Most Terrifying Hulk in New Preview',url:'https://www.yahoo.com/entertainment/movies/articles/spider-man-defies/'}]};
assert.strictEqual(h.validTopics({source:'google-rss',status:'ok',checked_at:'2026-10-29T11:00:00Z',topics:[{title:avengersArticle.headline,article_id:avengersArticle.id,url:'/news-item?id=g9harb',trend_proof:avengersProof}]},[avengersArticle],now).length,1);
const gtaArticle={id:'gta6story',headline:'Grand Theft Auto VI Reportedly Demands Massive Storage Space',published:'2026-10-29T09:00:00Z'};
const gtaProof={source:'google-rss',term:'gta vi',geo:'AU',started_at:'2026-10-29T08:00:00Z',observed_at:'2026-10-29T11:00:00Z',source_url:'https://trends.google.com/trending/rss?geo=AU',related:[{title:'Melbourne Just Got A Massive Grand Theft Auto 6 Mural',url:'https://press-start.com.au/news/gta-6-mural/'},{title:'New games in 2027: Fable, Final Fantasy 7, and (maybe) GTA 6 on PC',url:'https://www.pcgamer.com/games/new-pc-games-2027/'},{title:'Gaming Analyst Says GTA 6 Is Coming To PC In 6 Or 7 Months',url:'https://opencritic.com/news/gta-6-pc/'}]};
assert.strictEqual(h.validTopics({source:'google-rss',status:'ok',checked_at:'2026-10-29T11:00:00Z',topics:[{title:gtaArticle.headline,article_id:gtaArticle.id,url:'/news-item?id=gta6story',trend_proof:gtaProof}]},[gtaArticle],now).length,1);
const html=h.render(h.validTopics(payload,[article],now));
assert(!html.includes('Current Google search trends'), 'owner order 2026-10-30: no guidance line under the Trending Topics heading');
assert(html.includes('href="/news-item?id=story%201"'));
assert(!html.includes('newest first'), 'no sort caption in the rendered topics block');
console.log('Trending topics client tests passed');
