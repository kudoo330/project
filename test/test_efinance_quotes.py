import importlib.util,pathlib,unittest
from unittest.mock import patch,MagicMock
spec=importlib.util.spec_from_file_location('ef_quotes',pathlib.Path(__file__).resolve().parents[1]/'scripts/efinance_quotes.py')
q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
BAR={'date':'2026-10-19','open':10,'close':11,'high':12,'low':9,'volume':100}
class EFinanceTests(unittest.TestCase):
 def test_explicit_a_share_market_and_no_adjustment_default(self):
  self.assertEqual(q.quote_id('600802.SH'),'1.600802');self.assertEqual(q.quote_id('920344.BJ'),'0.920344')
  for symbol in ['AAPL','002626.SH','600802.SZ','600802','00700.HK']:
   with self.assertRaises(ValueError):q.normalize_symbol(symbol)
 def test_rows_require_correct_code_and_finite_prices(self):
  row={'股票代码':'002626','日期':'2026-10-19','开盘':10,'收盘':11,'最高':12,'最低':9,'成交量':100}
  self.assertEqual(q.normalize_rows([row],'002626.SZ','2026-10-19','2026-10-19'),[BAR])
  for changed in [{'股票代码':'600802'},{'收盘':float('nan')},{'最高':8}]:
   with self.assertRaises(ValueError):q.normalize_rows([{**row,**changed}],'002626.SZ','2026-10-19','2026-10-19')
 def test_library_unsafe_tls_argument_is_overridden_and_security_metadata_checked(self):
  transport=q.EFinanceTransport(['002626.SZ'])
  response=MagicMock();response.is_redirect=False;response.json.return_value={'rc':0,'data':{'code':'002626','market':0}};response.content=b'fixture';response.url='https://push2his.eastmoney.com/api/qt/stock/kline/get'
  session=MagicMock();session.__enter__.return_value=session;session.get.return_value=response
  params={'secid':'0.002626','fqt':'0','klt':'101'}
  with patch('requests.Session',return_value=session):
   transport.get(response.url,params=params,verify=False)
   args=session.get.call_args.kwargs
   self.assertNotEqual(args['verify'],False);self.assertFalse(args['allow_redirects']);self.assertEqual(args['timeout'],(5,15))
   self.assertTrue(transport.evidence['002626.SZ']['tlsVerified'])
   response.json.return_value={'rc':0,'data':{'code':'600802','market':0}}
   with self.assertRaises(ValueError):transport.get(response.url,params=params)
  for values in [{'fqt':'1'},{'klt':'1'},{'secid':'1.002626'}]:
   with self.assertRaises(ValueError):transport.get(response.url,params={**params,**values})
  with self.assertRaises(ValueError):transport.get('http://push2his.eastmoney.com/api/qt/stock/kline/get',params=params)
 def test_installed_efinance_parses_a_response_with_explicit_unadjusted_daily_arguments(self):
  from efinance import stock
  from efinance.common import getter
  response=MagicMock();response.json.return_value={'rc':0,'data':{'code':'002626','market':0,'name':'LOCAL FIXTURE','klines':['2026-10-19,10,11,12,9,100,110000,30,10,1,2']}}
  transport=MagicMock();transport.get.return_value=response
  with patch.object(getter,'session',transport):
   frame=stock.get_quote_history('0.002626',beg='20261019',end='20261019',klt=101,fqt=0,quote_id_mode=True)
   self.assertEqual(q.normalize_rows(frame.to_dict('records'),'002626.SZ','2026-10-19','2026-10-19'),[BAR])
   params=dict(transport.get.call_args.kwargs['params']);self.assertEqual(params['fqt'],'0');self.assertEqual(params['klt'],'101');self.assertEqual(params['secid'],'0.002626')
 def test_efinance_is_eastmoney_not_an_extra_independent_source(self):
  evidence={'primary':{'url':'https://push2his.eastmoney.com/'},'secondary':{'fetchedAt':'2026-10-19T09:00:00Z'}}
  quote,pending=q.verified_quote('002626.SZ','test',[BAR],[BAR],evidence,'0.5.9')
  self.assertEqual(quote['primaryProvider'],'东方财富');self.assertEqual(quote['secondaryProvider'],'腾讯');self.assertFalse(pending)
  self.assertEqual(quote['evidence']['client'],'efinance')
  for secondary in [[],[{**BAR,'close':10.99}]]:
   quote,pending=q.verified_quote('002626.SZ','test',[BAR],secondary,evidence,'0.5.9');self.assertIsNone(quote);self.assertEqual(len(pending),1)
if __name__=='__main__':unittest.main()
