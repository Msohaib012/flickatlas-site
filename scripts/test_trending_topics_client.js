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
for(const altered of [
 {...payload,source:'tavily'},
 {...payload,status:'stale'},
 {...payload,checked_at:'2026-10-29T08:59:59Z'},
 {...payload,topics:[{...topic,url:'https://evil.example/'}]},
 {...payload,topics:[{...topic,article_id:'absent'}]},
 {...payload,topics:[{...topic,title:'Unrelated'}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,source_url:'https://evil.example/rss'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,geo:'US'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,observed_at:'2026-10-28T11:59:59Z'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,observed_at:'2026-10-29T12:01:00Z'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,started_at:'2026-10-28T11:59:59Z'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,term:'movie'}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,related:[{title:'Jailer sports update',url:'https://flickatlas.co.uk/news'}]}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,related:[{title:'Jailer sports update',url:'https://flickatlas.com/news'}]}}]},
 {...payload,topics:[{...topic,trend_proof:{...proof,related:[{title:'Jailer sports update',url:'https://flickatlas-x.hidden-decodes.workers.dev/news'}]}}]}
]) assert.strictEqual(h.validTopics(altered,[article],now).length,0);
assert.strictEqual(h.validTopics(payload,[{...article,published:'2026-10-01T00:00:00Z'}],now).length,0);
const html=h.render(h.validTopics(payload,[article],now));
assert(!html.includes('Current Google search trends'), 'owner order 2026-10-30: no guidance line under the Trending Topics heading');
assert(html.includes('href="/news-item?id=story%201"'));
assert(!html.includes('newest first'), 'no sort caption in the rendered topics block');
console.log('Trending topics client tests passed');
