"""Backfill independently verified quotes through the admin API; preserve P0 and snapshot before writes."""
import argparse,importlib.util,pathlib,json,os,sys
spec=importlib.util.spec_from_file_location('tracker_admin',pathlib.Path(__file__).with_name('admin-website.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--quotes',required=True);p.add_argument('--backup',required=True);p.add_argument('--after',required=True);args=p.parse_args()
key=os.environ.get('TRACKER_ADMIN_PASSWORD')
if not key:sys.exit('TRACKER_ADMIN_PASSWORD is not configured.')
quotes=json.loads(pathlib.Path(args.quotes).read_text());client=mod.AdminClient(os.environ.get('TRACKER_ADMIN_USERNAME','admin'),key)
def save(path,data):
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w')as f:json.dump(data,f,ensure_ascii=False,indent=2)
def known(r,q):
 data=json.loads(r.get('market_data')or'{}');return all(any(b.get('date')==v['date']and b.get('close')==v['close']and b.get('crossCheck',{}).get('status')=='matched'for b in data.get('bars',[]))for v in q['bars'])
try:
 client.login();before=client.request('/api/records');save(args.backup,before);rows=before['records'];todo=[]
 for q in quotes:
  matches=[r for r in rows if r['symbol']==q['symbol']and r['buy_time'][:10]in{b['date']for b in q['bars']}]
  if matches and not all(known(r,q)for r in matches):todo.append(q)
 print('Missing quote symbols to apply:',len(todo),flush=True)
 updated=0
 for i in range(0,len(todo),6):
  result=client.request('/api/import-closes','POST',{'quotes':todo[i:i+6]});updated+=result.get('updated',0)
  if not result.get('ok'):raise mod.AdminError('Concurrent revision conflict; inspect applied batch before retry.')
  print('Applied symbols',min(i+6,len(todo)),'/',len(todo),'updated records',updated,flush=True)
 after=client.request('/api/records');save(args.after,after)
 previous={r['id']:r for r in rows};assert set(previous)=={r['id']for r in after['records']},'Record membership changed'
 for r in after['records']:
  for field in ['actual_price','reference_price','reference_evidence','original_time','buy_time','strategy_id']:
   assert r[field]==previous[r['id']][field],'Original buy data changed'
 good=0;pending=[]
 for r in after['records']:
  data=json.loads(r.get('market_data')or'{}');b=next((b for b in data.get('bars',[])if b['date']==r['buy_time'][:10]),None)
  if b and b.get('close',0)>0 and b.get('crossCheck',{}).get('status')=='matched':good+=1
  else:pending.append({'symbol':r['symbol'],'strategy':r.get('strategy_name')})
 print(json.dumps({'total':len(after['records']),'verified_D0':good,'pending':pending,'buy_data_unchanged':True,'updated_records':updated},ensure_ascii=False),flush=True)
except (mod.AdminError,AssertionError)as e:sys.exit(str(e))
finally:
 try:client.logout()
 except mod.AdminError:print('Logout not confirmed; session expires automatically.',file=sys.stderr)
