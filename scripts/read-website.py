"""Read the tracker using a scoped Codex proxy secret. Never prints credentials."""
import argparse,json,os,sys,urllib.request,urllib.error,pathlib
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl): return None
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--status',action='store_true',help='Read closing sync status instead of records')
p.add_argument('--output',help='Optional private local JSON output; never commit user data')
a=p.parse_args();key=os.environ.get('TRACKER_READ_TOKEN')
if not key:sys.exit('TRACKER_READ_TOKEN is not configured. Enter it securely in Codex environment settings.')
url='https://project.kudoo330.workers.dev/api/readonly/'+('close-sync' if a.status else 'records')
try:
    req=urllib.request.Request(url,headers={'X-Tracker-Read-Token':key,'Accept':'application/json','User-Agent':'ResearchJournal-Codex/0.5'})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=30)as response:data=json.load(response)
except urllib.error.HTTPError as e:sys.exit('Website HTTP '+str(e.code)+'; check read token and network configuration. Response body omitted.')
except (urllib.error.URLError,ValueError):sys.exit('Website network or JSON response failure. Check domain allowlist and runtime settings.')
if a.output:
    encoded=json.dumps(data,ensure_ascii=False,indent=2).replace(key,'[REDACTED]')
    with os.fdopen(os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w')as f:f.write(encoded)
if a.status:print(json.dumps(data,ensure_ascii=False).replace(key,'[REDACTED]'))
else:
    rows=data.get('records',[])
    print(json.dumps({'records':len(rows),'unique_stocks':len({r['symbol']for r in rows}),'strategies':{s:sum(r.get('strategy_name')==s for r in rows)for s in sorted({r.get('strategy_name','')for r in rows})},'output_saved':bool(a.output)},ensure_ascii=False))
