const http = require('node:http');
const fs = require('node:fs/promises');
const dns = require('node:dns/promises');
const net = require('node:net');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const blocked = new Set(['google.com','youtube.com','instagram.com','facebook.com','linkedin.com','wikipedia.org','amazon.com','pinterest.com','reddit.com','x.com','twitter.com','tiktok.com','rocketreach.co','zoominfo.com','hunter.io','apollo.io','crunchbase.com','yelp.com','trustpilot.com']);
const searches = new Map();
const cache = new Map();
const normalize = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
const host = url => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./,''); } catch { return ''; } };
const excluded = h => [...blocked].some(b => h === b || h.endsWith('.'+b));
const reply = (res,status,data) => { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(JSON.stringify(data)); };
const fail = (message,status=500) => Object.assign(new Error(message),{status});
function isPrivateIP(ip) {
  const kind=net.isIP(ip);
  if(kind===4) {
    const a=ip.split('.').map(Number);
    return a[0]===0 || a[0]===10 || a[0]===127 || a[0]>=224 || (a[0]===169&&a[1]===254) || (a[0]===172&&a[1]>=16&&a[1]<=31) || (a[0]===192&&a[1]===168) || (a[0]===100&&a[1]>=64&&a[1]<=127);
  }
  if(kind===6) return /^(::|::1|f[cd]|fe[89ab]|ff|::ffff:)/i.test(ip);
  return true;
}
async function checkUrl(raw) {
  let u; try { u=new URL(raw); } catch { throw fail('Invalid website URL'); }
  if(!['http:','https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80','443'].includes(u.port)) || !u.hostname.includes('.') || net.isIP(u.hostname) || /\.local$|\.internal$/i.test(u.hostname)) throw fail('Non-public website');
  const ips=await dns.lookup(u.hostname,{all:true});
  if(!ips.length || ips.some(x=>isPrivateIP(x.address))) throw fail('Non-public website');
  return u.href;
}
async function getPage(url) {
  for(let redirects=0; redirects<4; redirects++) {
    await checkUrl(url);
    const result=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'User-Agent':'Mozilla/5.0 BrandMail/1.0','Accept':'text/html'}});
    if([301,302,303,307,308].includes(result.status)) { const next=result.headers.get('location'); if(!next) throw fail('Bad redirect'); url=new URL(next,url).href; continue; }
    if(!result.ok || !/text\/html|application\/xhtml/i.test(result.headers.get('content-type') || '')) throw fail('Page unavailable');
    if(Number(result.headers.get('content-length') || 0)>1300000) throw fail('Page too large');
    const buffer=await result.arrayBuffer();
    if(buffer.byteLength>1300000) throw fail('Page too large');
    return {url,html:Buffer.from(buffer).toString('utf8')};
  }
  throw fail('Too many redirects');
}
async function google(query) {
  const key=process.env.SERPER_API_KEY;
  if(!key) throw fail('Search is not configured yet. The site owner must add SERPER_API_KEY in Render Environment settings.',503);
  let response;
  try {
    response=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'X-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify({q:query,num:10,hl:'en'}),signal:AbortSignal.timeout(10000)});
  } catch { throw fail('Google search could not be reached. Try again.',502); }
  if(!response.ok) throw fail(response.status===401 || response.status===403?'Search API key is invalid.':'Search API returned '+response.status,502);
  return response.json();
}
function officialSite(results,brand) {
  const brandKey=normalize(brand);
  const options=[];
  if(results.knowledgeGraph?.website) options.push({link:results.knowledgeGraph.website,title:brand,bonus:75});
  for(const [i,x] of (results.organic||[]).entries()) options.push({link:x.link,title:x.title||'',bonus:Math.max(0,18-i*2)});
  return options.map(x=>{
    const h=host(x.link);
    if(!h || excluded(h)) return null;
    let u; try {u=new URL(x.link);} catch {return null;}
    if(!['http:','https:'].includes(u.protocol)) return null;
    const base=normalize(h.split('.')[0]);
    const title=normalize(x.title);
    let score=x.bonus;
    if(brandKey.length>=3 && base===brandKey) score+=80;
    else if(brandKey.length>=3 && normalize(h).includes(brandKey)) score+=60;
    if(title.includes(brandKey) && brandKey.length>2) score+=14;
    if(/\bofficial\b/i.test(x.title)) score+=14;
    if(u.pathname==='/' || u.pathname==='') score+=5;
    return {root:u.origin+'/',siteHost:h,score};
  }).filter(Boolean).sort((a,b)=>b.score-a.score)[0] || null;
}
function decode(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|amp|commat|period|quot|apos|nbsp);?/gi,(_,e)=>{
    const v=e.toLowerCase();
    if(v.startsWith('#')) { const code=v[1]==='x'?parseInt(v.slice(2),16):parseInt(v.slice(1),10); return code>0&&code<=0x10ffff?String.fromCodePoint(code):' '; }
    return ({amp:'&',commat:'@',period:'.',quot:'"',apos:"'",nbsp:' '})[v]||' ';
  });
}
const pattern=/\b[a-zA-Z0-9][a-zA-Z0-9._%+-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9.-]{1,250}\.[a-zA-Z]{2,22}\b/g;
function emailsFrom(markup,url,siteHost) {
  const content=decode(markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<!--[\s\S]*?-->/g,' '));
  const emails=new Map();
  for(const match of content.matchAll(pattern)) {
    const email=match[0].toLowerCase(), [name,domain]=email.split('@');
    if(/^(noreply|no-reply|donotreply|example|test|sample|fake|username|yourname)$/.test(name) || domain==='example.com' || /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(domain)) continue;
    let score=(domain===siteHost || domain.endsWith('.'+siteHost))?50:0;
    if(/^(info|hello|contact|inquiries|enquiries|office|enquiry|inquiry)/.test(name)) score+=35;
    else if(/^(support|help|team|customerservice|customer.service)/.test(name)) score+=30;
    else if(/^(sales|press|media|partnerships|business|marketing)/.test(name)) score+=20;
    if(/^(privacy|legal|security|abuse|webmaster|gdpr|dmca)/.test(name)) score-=25;
    if(/contact|support|help/i.test(url)) score+=10;
    if(content.toLowerCase().includes('mailto:'+email)) score+=12;
    emails.set(email,{email,sourceUrl:url,score});
  }
  return [...emails.values()];
}
function linksFrom(html,page,siteHost) {
  const found=[];
  for(const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const u=new URL(decode(m[1]),page);
      if(host(u.href)!==siteHost || !['http:','https:'].includes(u.protocol)) continue;
      if(/contact|about|support|help|reach-us|get-in-touch/i.test(u.pathname)) {u.hash=''; found.push(u.href);}
    } catch {}
  }
  return [...new Set(found)].slice(0,7);
}
async function lookup(brand) {
  const result=await google(brand+' official website');
  const site=officialSite(result,brand);
  if(!site || site.score<25) return {brand,website:null,emails:[],note:'Could not identify an official website. Try a more specific brand name.'};
  const pages=[]; const pending=[];
  try {
    const home=await getPage(site.root);
    pages.push(home);
    pending.push(...linksFrom(home.html,home.url,host(home.url)));
  } catch {}
  for(const extra of ['/contact','/contact-us','/pages/contact','/about','/support']) pending.push(new URL(extra,site.root).href);
  const unique=[...new Set(pending)].slice(0,7);
  const crawled=await Promise.allSettled(unique.map(url=>getPage(url)));
  for(const p of crawled) if(p.status==='fulfilled' && host(p.value.url)===site.siteHost) pages.push(p.value);
  const map=new Map();
  for(const page of pages) for(const entry of emailsFrom(page.html,page.url,site.siteHost)) {
    const last=map.get(entry.email); if(!last || entry.score>last.score) map.set(entry.email,entry);
  }
  if(!map.size) {
    try {
      const results=await google('site:'+site.siteHost+' contact email');
      for(const item of (results.organic||[]).slice(0,6)) {
        if(host(item.link)!==site.siteHost) continue;
        for(const e of emailsFrom(item.snippet||'',item.link,site.siteHost)) {
          e.score-=20; if(!map.has(e.email)) map.set(e.email,e);
        }
      }
    } catch {}
  }
  const emails=[...map.values()].sort((a,b)=>b.score-a.score).slice(0,10).map(e=>({email:e.email,sourceUrl:e.sourceUrl}));
  return {brand,website:site.root,emails,checkedPages:pages.length,note:emails.length?'Publicly listed addresses; inbox ownership and deliverability are not verified.':'No public emails found on the pages checked. No addresses were guessed.'};
}
const files={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8']};
const server=http.createServer(async (req,res)=>{
  let u; try{u=new URL(req.url,'http://localhost');}catch{return reply(res,400,{error:'Invalid URL'});}
  if(u.pathname==='/api/health') return reply(res,200,{ok:true,configured:Boolean(process.env.SERPER_API_KEY)});
  if(u.pathname==='/api/search' && req.method==='POST') {
    const ip=req.socket.remoteAddress||'unknown', now=Date.now();
    const recent=(searches.get(ip)||[]).filter(t=>now-t<60000);
    if(recent.length>=10) return reply(res,429,{error:'Too many searches. Try again in one minute.'});
    recent.push(now);searches.set(ip,recent);
    if(searches.size>1000) searches.clear();
    let body='';
    try {
      for await(const chunk of req) {body+=chunk.toString();if(body.length>2000)return reply(res,413,{error:'Too much input.'});}
      const input=JSON.parse(body);
      const brand=String(input.brand||'').trim().replace(/\s+/g,' ');
      if(!brand || brand.length>80 || !/[\p{L}\p{N}]/u.test(brand) || /[<>]/.test(brand)) return reply(res,400,{error:'Enter one brand name (up to 80 characters).'});
      const k=normalize(brand);
      const cached=cache.get(k);
      if(cached && now-cached.saved<1800000) return reply(res,200,{...cached.result,cached:true});
      const result=await lookup(brand);
      cache.set(k,{saved:Date.now(),result});if(cache.size>300)cache.clear();
      return reply(res,200,result);
    } catch(e) {console.error('Lookup:',e.message);return reply(res,e.status||500,{error:e.status?e.message:'Could not finish this search. Try again.'});}
  }
  if(req.method!=='GET') return reply(res,405,{error:'Method not allowed'});
  if(!files[u.pathname]) return reply(res,404,{error:'Not found'});
  try {
    const [name,contentType]=files[u.pathname];
    const data=await fs.readFile(path.join(__dirname,'public',name));
    res.writeHead(200,{'content-type':contentType,'x-content-type-options':'nosniff','cache-control':'no-cache'});res.end(data);
  } catch {reply(res,500,{error:'Page unavailable'});}
});
server.listen(PORT,'0.0.0.0',()=>console.log('BrandMail listening on '+PORT));
