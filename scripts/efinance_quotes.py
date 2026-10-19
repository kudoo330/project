"""Read-only efinance daily quotes, verified against Tencent; never writes to the website."""
import argparse,concurrent.futures,datetime as dt,hashlib,importlib.metadata,json,math,os,pathlib,re,ssl,sys,urllib.parse,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
SH=dt.timezone(dt.timedelta(hours=8))

def normalize_symbol(value):
    symbol=str(value).strip().upper()
    if not re.fullmatch(r'\d{6}\.(SH|SZ|BJ)',symbol):raise ValueError('Use an explicit A-share symbol, e.g. 600802.SH')
    code,market=symbol.split('.')
    prefixes={'SH':('600','601','603','605','688','689'),'SZ':('000','001','002','003','300','301'),'BJ':('43','83','87','88','92')}
    if not code.startswith(prefixes[market]):raise ValueError('Code prefix and exchange do not match a supported A-share')
    return symbol

def quote_id(symbol):
    code,exchange=normalize_symbol(symbol).split('.')
    return ('1' if exchange=='SH' else '0')+'.'+code

def valid_bar(bar):
    numbers=[bar.get(k) for k in ('open','close','high','low','volume')]
    if any(not isinstance(n,(int,float)) or isinstance(n,bool) or not math.isfinite(n) for n in numbers):raise ValueError('Non-finite OHLCV')
    if min(numbers[:4])<=0 or numbers[4]<0 or not bar['low']<=bar['open']<=bar['high'] or not bar['low']<=bar['close']<=bar['high']:raise ValueError('Invalid OHLCV')
    dt.date.fromisoformat(bar['date'])
    return bar

def normalize_rows(rows,symbol,start,end):
    code=symbol[:6];bars=[];seen=set()
    for row in rows:
        if str(row.get('股票代码','')).zfill(6)!=code:raise ValueError('Returned stock code does not match request')
        day=str(row['日期'])
        if len(day)!=10:raise ValueError('Expected daily date, not minute data')
        if not start<=day<=end:continue
        if day in seen:raise ValueError('Duplicate daily date')
        seen.add(day)
        bars.append(valid_bar({'date':day,**{target:float(row[source]) for target,source in [('open','开盘'),('close','收盘'),('high','最高'),('low','最低'),('volume','成交量')]}}))
    return sorted(bars,key=lambda b:b['date'])

class EFinanceTransport:
    """efinance 0.5.9 passes verify=False; this scoped transport always verifies TLS."""
    def __init__(self,symbols):self.symbols={quote_id(s):s for s in symbols};self.evidence={}
    def get(self,url,**kwargs):
        import requests
        parsed=urllib.parse.urlsplit(url);params=dict(kwargs.get('params',()))
        if parsed.scheme!='https' or parsed.hostname!='push2his.eastmoney.com' or parsed.path!='/api/qt/stock/kline/get':raise ValueError('Unexpected efinance destination')
        secid=params.get('secid');symbol=self.symbols.get(secid)
        if not symbol or str(params.get('fqt'))!='0' or str(params.get('klt'))!='101':raise ValueError('Only unadjusted A-share daily requests are allowed')
        verify=os.environ.get('REQUESTS_CA_BUNDLE') or ssl.get_default_verify_paths().cafile or True
        with requests.Session() as session:
            response=session.get(url,params=params,headers=kwargs.get('headers'),timeout=(5,15),allow_redirects=False,verify=verify)
            if response.is_redirect:raise ValueError('Unexpected market-data redirect')
            response.raise_for_status();payload=response.json()
            if payload.get('rc')!=0:raise ValueError('Eastmoney returned an error')
            data=payload.get('data')
            if not isinstance(data,dict) or data.get('code')!=symbol[:6] or data.get('market')!=int(secid[0]):raise ValueError('Security code/market metadata not verified')
            if symbol.endswith('.BJ') and data.get('qtMiscType')!=4 and data.get('type')!=81:raise ValueError('Beijing classification not verified')
            if symbol.endswith('.SZ') and (data.get('qtMiscType')==4 or data.get('type')==81):raise ValueError('Unexpected Beijing classification')
            self.evidence[symbol]={'url':response.url,'fetchedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'sha256':hashlib.sha256(response.content).hexdigest(),'code':data['code'],'market':data['market'],'qtMiscType':data.get('qtMiscType'),'type':data.get('type'),'tlsVerified':True,'fqt':0,'klt':101}
            return response

def tencent_daily(symbol,start,end):
    key=symbol[-2:].lower()+symbol[:6]
    url='https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?'+urllib.parse.urlencode({'param':key+',day,,,600,'})
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://quote.eastmoney.com/'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args):return None
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=20) as response:
        raw=response.read(2000001)
    if len(raw)>2000000:raise ValueError('Oversized secondary response')
    data=json.loads(raw)
    if data.get('code')!=0:raise ValueError('Secondary returned an error')
    rows=data.get('data',{}).get(key,{}).get('day',[])
    bars=[valid_bar({'date':r[0],'open':float(r[1]),'close':float(r[2]),'high':float(r[3]),'low':float(r[4]),'volume':float(r[5])}) for r in rows if start<=r[0]<=end]
    if len({b['date'] for b in bars})!=len(bars):raise ValueError('Duplicate secondary date')
    return bars,{'url':url,'fetchedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'sha256':hashlib.sha256(raw).hexdigest()}

def verified_quote(symbol,name,primary,secondary,evidence,version):
    others={b['date']:b for b in secondary};matched=[];pending=[]
    for b in primary:
        other=others.get(b['date'])
        if other and abs(b['close']-other['close'])<1e-8:matched.append(b)
        else:pending.append({'date':b['date'],'status':'mismatch' if other else 'secondary_missing','primaryClose':b['close'],'secondaryClose':other['close'] if other else None})
    quote=None
    if matched:
        quote={'symbol':symbol,'name':name,'primaryProvider':'东方财富','bars':matched,'secondaryProvider':'腾讯','secondary':[others[b['date']] for b in matched],'fetchedAt':evidence['secondary']['fetchedAt'],'evidence':{**evidence,'client':'efinance','clientVersion':version,'upstream':'东方财富','adjustment':'none','interval':'1d','independentProviders':['东方财富','腾讯']}}
    return quote,pending

def save_private(path,value):
    path=pathlib.Path(path).resolve()
    if path==ROOT or ROOT in path.parents:raise ValueError('Save market data outside the Git checkout')
    path.parent.mkdir(parents=True,exist_ok=True)
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w')as f:json.dump(value,f,ensure_ascii=False,indent=2,allow_nan=False)

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--symbols',nargs='+');p.add_argument('--records-file',help='Local /api/records snapshot; symbols are deduplicated')
    p.add_argument('--start',required=True);p.add_argument('--end',required=True);p.add_argument('--output',required=True);p.add_argument('--quotes-output',help='Optional array accepted by the separate reviewed backfill helper')
    p.add_argument('--workers',type=int,choices=[1,2],default=2);a=p.parse_args(argv)
    if bool(a.symbols)==bool(a.records_file):p.error('Choose --symbols or --records-file')
    start=dt.date.fromisoformat(a.start);end=dt.date.fromisoformat(a.end);local=dt.datetime.now(SH)
    cutoff=local.date() if local.time()>=dt.time(16,5) else local.date()-dt.timedelta(days=1)
    if end<start or end>cutoff or (end-start).days>31:p.error('Use a completed interval of at most 31 calendar days')
    calendar=json.loads((ROOT/'src/calendar.json').read_text());expected=[d for d in calendar if a.start<=d<=a.end]
    if a.start<calendar[0] or a.end>calendar[-1] or not expected:p.error('Interval must be within the loaded trading calendar')
    symbols=a.symbols if a.symbols else [r['symbol'] for r in json.loads(pathlib.Path(a.records_file).read_text())['records']]
    symbols=sorted({normalize_symbol(s) for s in symbols})
    if not symbols or len(symbols)>500:p.error('Choose 1 to 500 unique stocks')
    import efinance
    from efinance.common import getter
    version=importlib.metadata.version('efinance');transport=EFinanceTransport(symbols);old=getter.session;getter.session=transport
    def fetch(symbol):
        result={'symbol':symbol,'provider':'efinance（东方财富）','status':'pending'}
        try:
            frame=efinance.stock.get_quote_history(quote_id(symbol),beg=start.strftime('%Y%m%d'),end=end.strftime('%Y%m%d'),klt=101,fqt=0,quote_id_mode=True)
            rows=frame.to_dict('records');primary=normalize_rows(rows,symbol,a.start,a.end)
            if not primary:raise ValueError('No valid primary daily bars; not evidence of suspension')
            secondary,second_evidence=tencent_daily(symbol,a.start,a.end)
            quote,pending=verified_quote(symbol,str(rows[0].get('股票名称','')),primary,secondary,{'primary':transport.evidence[symbol],'secondary':second_evidence},version)
            missing=sorted(set(expected)-{b['date'] for b in primary})
            result.update(quote=quote,pending=pending,missing_dates=missing,status='verified' if quote and not pending and not missing else 'partial' if quote else 'pending')
        except Exception as e:
            # Exceptions from this read-only helper contain only public market URLs.
            result['error']=type(e).__name__+': '+str(e)[:500]
        print(json.dumps({'symbol':symbol,'status':result['status'],'error':result.get('error')},ensure_ascii=False),flush=True)
        return result
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers)as pool:results=list(pool.map(fetch,symbols))
    finally:getter.session=old
    quotes=[r['quote'] for r in results if r.get('quote')]
    # The website accepts at most eleven observation dates per quote.
    if any(len(q['bars'])>11 for q in quotes):raise ValueError('More than 11 dates: choose a shorter interval before preparing imports')
    report={'client':'efinance','clientVersion':version,'upstream':'东方财富','independentSource':False,'symbols':len(symbols),'verifiedSymbols':sum(r['status']=='verified' for r in results),'preparedQuotes':len(quotes),'websiteWrites':0,'results':results}
    save_private(a.output,report)
    if a.quotes_output:save_private(a.quotes_output,quotes)
    print(json.dumps({k:v for k,v in report.items()if k!='results'},ensure_ascii=False))
    return 0 if report['verifiedSymbols']==len(symbols) else 2

if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,OSError,KeyError)as e:sys.exit(str(e))
