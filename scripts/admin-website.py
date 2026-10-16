"""Use the website's normal admin session via scoped Codex environment credentials."""
import argparse,json,os,sys,urllib.request,urllib.error,urllib.parse,http.cookies
ORIGIN='https://project.kudoo330.workers.dev'
class AdminError(Exception): pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl): return None
class AdminClient:
    def __init__(self,username,password,origin=ORIGIN):
        self.origin=origin;self.username=username;self.password=password;self.cookie=None
        self.opener=urllib.request.build_opener(NoRedirect())
    def _request(self,path,method='GET',data=None,login=False):
        parsed=urllib.parse.urlsplit(path)
        if not path.startswith('/api/')or parsed.scheme or parsed.netloc or parsed.fragment or '\\'in path or '\r'in path or '\n'in path:
            raise AdminError('Only same-site /api/ paths are allowed.')
        headers={'Accept':'application/json','Content-Type':'application/json','User-Agent':'ResearchJournal-Codex/0.6','Origin':self.origin}
        if login:headers['X-Tracker-Admin-Password']=self.password
        elif self.cookie:headers['Cookie']=self.cookie
        if data is None and method not in ('GET','HEAD'):data={}
        req=urllib.request.Request(self.origin+path,data=None if data is None else json.dumps(data,ensure_ascii=False).encode(),headers=headers,method=method)
        try:
            with self.opener.open(req,timeout=60)as response:
                result=json.load(response)
                if login:
                    cookies=http.cookies.SimpleCookie();cookies.load(response.headers.get('Set-Cookie',''))
                    name='__Host-session'if self.origin.startswith('https:')else'dev-session'
                    if name not in cookies:raise AdminError('Login returned no session cookie.')
                    self.cookie=name+'='+cookies[name].value
                return result
        except urllib.error.HTTPError as e:raise AdminError('Website HTTP '+str(e.code)+'; response body omitted to protect credentials.')from None
        except (urllib.error.URLError,ValueError):raise AdminError('Network or JSON response failure.')from None
    def login(self):
        result=self._request('/api/login','POST',{'username':self.username},login=True)
        if result.get('role')!='admin':
            self.logout();raise AdminError('The configured user is not an administrator.')
        return result
    def request(self,path,method='GET',data=None):
        if not self.cookie:raise AdminError('Admin login required.')
        if path.split('?')[0]in('/api/login','/api/logout'):raise AdminError('Use the managed login/logout methods.')
        return self._request(path,method,data)
    def logout(self):
        try:
            if self.cookie:self._request('/api/logout','POST',{})
        finally:self.cookie=None

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--path',default='/api/records',help='Same-site API path; default reads records')
    p.add_argument('--method',choices=['GET','POST','PATCH','DELETE'],default='GET')
    p.add_argument('--body-file',help='JSON request body for an explicitly requested write operation')
    p.add_argument('--output',help='Optional private local JSON output outside Git')
    a=p.parse_args();username=os.environ.get('TRACKER_ADMIN_USERNAME','admin');password=os.environ.get('TRACKER_ADMIN_PASSWORD')
    if not password:sys.exit('TRACKER_ADMIN_PASSWORD is missing. Fill the secure Codex environment setting, not chat.')
    if a.method!='GET'and not a.body_file:p.error('Write operations require --body-file with the concrete requested payload.')
    payload=None
    if a.body_file:
        try:
            with open(a.body_file)as f:payload=json.load(f)
        except (OSError,ValueError):sys.exit('Cannot read the JSON payload file.')
    client=AdminClient(username,password)
    try:
        client.login();result=client.request(a.path,a.method,payload)
        # Never output response headers, cookies, or newly generated read-access tokens.
        if a.output:
            if a.path.split('?')[0]=='/api/read-access':raise AdminError('Do not save generated credentials to files.')
            encoded=json.dumps(result,ensure_ascii=False,indent=2).replace(password,'[REDACTED]')
            with os.fdopen(os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w')as f:f.write(encoded)
        if a.path.split('?')[0]=='/api/records'and a.method=='GET':
            rows=result.get('records',[]);summary={'role':'admin','records':len(rows),'unique_stocks':len({r['symbol']for r in rows}),'strategies':{s:sum(r.get('strategy_name')==s for r in rows)for s in sorted({r.get('strategy_name','')for r in rows})},'limit':result.get('limit'),'output_saved':bool(a.output)}
        else:summary={'role':'admin','method':a.method,'path':a.path,'request_succeeded':True,'output_saved':bool(a.output)}
        print(json.dumps(summary,ensure_ascii=False).replace(password,'[REDACTED]'))
    except AdminError as e:sys.exit(str(e))
    finally:
        try:client.logout()
        except AdminError:print('Logout could not be confirmed; the server session expires automatically.',file=sys.stderr)
if __name__=='__main__':main()
