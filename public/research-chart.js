/* Interactive, read-only price chart. Research marks never imply broker fills. */
const SESSION_LABELS={pre:'盘前',regular:'常规',post:'盘后'};
const STATUS_LABELS={available:'可用',partial:'不完整',missing:'缺失',not_entitled:'权限受限',request_failed:'获取失败',no_eligible_trade:'无合格成交'};
const PALETTE=['#237f72','#7865bd','#b76b35','#3e77b6','#b6567b','#829344'];
const MINUTE=60;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const timestamp=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(value)/1000:NaN;
const price=value=>finite(value)?value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4}):'—';
const safeColor=(value,fallback)=>/^#[\da-f]{6}$/i.test(value||'')?value:fallback;
const actionLetter=action=>({BUY:'B',SELL:'S',REBUY:'R'})[action]||'·';
const nyCalendarDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});

/**
 * Uses UTC epoch seconds on the axis; timezones affect labels only.
 * callbacks: onBarClick/onTimeClick({bar,timeUtc}), onMarkerClick({marker,markers,timeUtc}),
 * onHover({bar,timeUtc}|null), onVisibleRangeChange/onRangeChange({from,to}).
 */
export function createResearchChart(container,options={}){
  const lib=window.LightweightCharts;
  if(!lib?.createChart)throw new Error('K线组件未加载，请刷新页面');
  let destroyed=false,timeZone='America/New_York',timeframe='1m',rows=[],marks=[],groups=[],datasetKey='',suppressRange=false,frame=0,selectedId=null,dense=false;
  let rowByTime=new Map(),rowByDate=new Map(),displayMarks=new Map(),lastRangeKey='';
  container.style.position='relative';container.style.minWidth='0';
  const host=document.createElement('div');host.style.cssText='position:absolute;inset:0;min-width:0;';
  host.setAttribute('aria-label','价格K线与成交量，支持拖动、缩放和点击研究时点');
  const bands=document.createElementNS('http://www.w3.org/2000/svg','svg');
  bands.setAttribute('aria-hidden','true');bands.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:2;overflow:hidden;';
  container.append(host,bands);
  const chart=lib.createChart(host,{
    width:Math.max(200,container.clientWidth),height:Math.max(240,container.clientHeight||480),
    layout:{background:{type:'solid',color:'#ffffff'},textColor:'#788490',fontFamily:'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',fontSize:11,attributionLogo:true},
    grid:{vertLines:{visible:false},horzLines:{color:'#e5e9ed'}},
    rightPriceScale:{borderVisible:false,scaleMargins:{top:.12,bottom:.27}},
    timeScale:{borderVisible:false,timeVisible:true,secondsVisible:false,minBarSpacing:.5,rightOffset:5},
    crosshair:{mode:lib.CrosshairMode.Normal,vertLine:{color:'#8b9aa5',style:lib.LineStyle.Dashed},horzLine:{color:'#8b9aa5',style:lib.LineStyle.Dashed}},
    handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},
    handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:true},
    localization:{locale:'zh-CN',priceFormatter:price},
  });
  // US charts use green up / red down, independently from the A-share palette.
  const candles=chart.addSeries(lib.CandlestickSeries,{upColor:'#278b71',downColor:'#cd6260',borderVisible:false,wickUpColor:'#278b71',wickDownColor:'#cd6260',lastValueVisible:true,priceLineVisible:false});
  const volume=chart.addSeries(lib.HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'',lastValueVisible:false,priceLineVisible:false});
  volume.priceScale().applyOptions({scaleMargins:{top:.8,bottom:0}});
  const markerPlugin=lib.createSeriesMarkers(candles,[],{autoScale:true,zOrder:'top'});
  let dateTime=new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  let clock=new Intl.DateTimeFormat('zh-CN',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  let shortDate=new Intl.DateTimeFormat('zh-CN',{timeZone,month:'2-digit',day:'2-digit'});
  let yearDate=new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric'});

  function axisTime(value,kind){
    const t=typeof value==='number'?value:typeof value==='string'?timestamp(value+'T12:00:00Z'):Date.UTC(value.year,value.month-1,value.day,12)/1000;
    const row=rowByTime.get(t);
    if(timeframe==='1d'&&row?.trading_date)return kind===0?row.trading_date.slice(0,4):row.trading_date.slice(5);
    const d=new Date(t*1000);
    return kind===0?yearDate.format(d):kind===1||kind===2?shortDate.format(d):clock.format(d);
  }
  function fullTime(value){
    const t=typeof value==='number'?value:typeof value==='string'?timestamp(value+'T12:00:00Z'):Date.UTC(value.year,value.month-1,value.day,12)/1000;
    const row=rowByTime.get(t);return timeframe==='1d'&&row?.trading_date?row.trading_date:dateTime.format(new Date(t*1000));
  }
  function setTimezone(zone){
    timeZone=zone==='Asia/Shanghai'?'Asia/Shanghai':'America/New_York';
    dateTime=new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    clock=new Intl.DateTimeFormat('zh-CN',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    shortDate=new Intl.DateTimeFormat('zh-CN',{timeZone,month:'2-digit',day:'2-digit'});
    yearDate=new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric'});
    chart.applyOptions({localization:{timeFormatter:fullTime},timeScale:{tickMarkFormatter:axisTime}});
  }
  function setTheme(theme){
    const dark=theme==='dark';
    chart.applyOptions({layout:{background:{type:'solid',color:dark?'#192630':'#ffffff'},textColor:dark?'#9cabb7':'#788490'},grid:{horzLines:{color:dark?'#2c3c47':'#e5e9ed'}},crosshair:{vertLine:{labelBackgroundColor:dark?'#466373':'#657a87'},horzLine:{labelBackgroundColor:dark?'#466373':'#657a87'}}});
    drawBands();
  }
  function drawBands(){
    if(destroyed)return;
    bands.replaceChildren();
    if(!rows.length||timeframe==='1d')return;
    const width=Math.max(0,container.clientWidth-chart.priceScale('right').width()),height=Math.max(0,container.clientHeight-chart.timeScale().height());
    bands.setAttribute('width',String(width));bands.setAttribute('height',String(height));
    const logical=chart.timeScale().getVisibleLogicalRange(),spacing=chart.timeScale().options().barSpacing||6;
    if(!logical)return;
    let segments=[];
    for(let i=Math.max(0,Math.floor(logical.from)-1);i<Math.min(rows.length,Math.ceil(logical.to)+2);i++){
      const row=rows[i],key=row.trading_date+'|'+row.session;
      const last=segments.at(-1);
      if(last?.key===key)last.end=i;else segments.push({key,start:i,end:i,session:row.session});
    }
    for(const segment of segments){
      const start=chart.timeScale().timeToCoordinate(rows[segment.start]._time),end=chart.timeScale().timeToCoordinate(rows[segment.end]._time);
      if(start===null||end===null)continue;
      const x=Math.max(0,start-spacing/2),right=Math.min(width,end+spacing/2);
      if(right<=x)continue;
      if(segment.session!=='regular'){
        const rect=document.createElementNS(bands.namespaceURI,'rect');
        rect.setAttribute('x',String(x));rect.setAttribute('y','0');rect.setAttribute('width',String(right-x));rect.setAttribute('height',String(height));
        rect.setAttribute('fill',segment.session==='pre'?'#a78440':'#7973b4');rect.setAttribute('fill-opacity','.055');bands.append(rect);
      }
      // A session delimiter is drawn without inventing bars during a closure.
      if(start-spacing/2>0){
        const line=document.createElementNS(bands.namespaceURI,'line');line.setAttribute('x1',String(x));line.setAttribute('x2',String(x));line.setAttribute('y1','0');line.setAttribute('y2',String(height));line.setAttribute('stroke','#8c9ba6');line.setAttribute('stroke-opacity','.28');line.setAttribute('stroke-dasharray','3 5');bands.append(line);
      }
      if(right-x>65){
        const label=document.createElementNS(bands.namespaceURI,'text');label.setAttribute('x',String(x+6));label.setAttribute('y','15');label.setAttribute('fill','#87939b');label.setAttribute('font-size','10');label.textContent=SESSION_LABELS[segment.session]||'';bands.append(label);
      }
    }
  }
  function queueBands(){cancelAnimationFrame(frame);frame=requestAnimationFrame(drawBands);}
  function normalizeBars(data){
    const seen=new Set(),normalized=[];
    for(const original of data||[]){
      const t=timestamp(original.time_utc||original.interval_start_utc||original.time_key||original.time);
      if(!Number.isFinite(t)||seen.has(t))continue;
      seen.add(t);
      const end=timestamp(original.end_utc||original.interval_end_utc);
      normalized.push({...original,_time:t,_end:Number.isFinite(end)?end:t+(timeframe==='1d'?86400:parseInt(timeframe,10)*MINUTE),_valid:[original.open,original.high,original.low,original.close].every(finite)&&original.open>0&&original.close>0&&original.low>0&&original.high>=original.low});
    }
    return normalized.sort((a,b)=>a._time-b._time);
  }
  function rowAtTime(t){
    if(!Number.isFinite(t))return null;
    // A daily candle is contextual for its NY calendar date, including a manually
    // recorded pre/post-market observation. Its OHLC is never used as that fill.
    if(timeframe==='1d')return rowByDate.get(nyCalendarDate.format(new Date(t*1000)))||null;
    let low=0,high=rows.length-1,index=-1;
    while(low<=high){const mid=(low+high)>>1;if(rows[mid]._time<=t){index=mid;low=mid+1;}else high=mid-1;}
    const found=rows[index];return found&&t<found._end?found:null;
  }
  function markerTime(marker){return timestamp(marker.time_utc||marker.marker_time_utc||marker.time||marker.original_time);}
  function renderMarkers(){
    if(destroyed)return;
    const colors=new Map(groups.map((g,i)=>[g.id,safeColor(g.color,PALETTE[i%PALETTE.length])]));
    const known=new Map(),prepared=[];displayMarks=new Map();
    marks.forEach((marker,index)=>{
      const t=markerTime(marker),row=rowAtTime(t);if(!row?._valid)return;
      if(!known.has(marker.group_id))known.set(marker.group_id,known.size);
      const position=marker.action==='SELL'?'aboveBar':'belowBar',key=row._time+'|'+position;
      const item={marker,index,row,color:colors.get(marker.group_id)||safeColor(marker.group_color,PALETTE[known.get(marker.group_id)%PALETTE.length]),position};
      let list=prepared.find(x=>x.key===key);if(!list){list={key,items:[]};prepared.push(list);}list.items.push(item);
    });
    const seriesMarkers=[];dense=(chart.timeScale().options().barSpacing||6)<8;
    for(const bucket of prepared){
      if(dense&&bucket.items.length>3){
        const first=bucket.items[0],id='cluster:'+first.marker.id;
        displayMarks.set(id,bucket.items.map(x=>x.marker));seriesMarkers.push({time:first.row._time,position:first.position,shape:'circle',color:first.color,text:String(bucket.items.length)+'标',id,size:1});
      }else for(const item of bucket.items){
        const id=String(item.marker.id);displayMarks.set(id,[item.marker]);
        seriesMarkers.push({time:item.row._time,position:item.position,shape:item.marker.action==='SELL'?'arrowDown':item.marker.action==='REBUY'?'circle':'arrowUp',color:item.color,text:actionLetter(item.marker.action)+' '+(item.marker.sequence??item.index+1),id,size:selectedId===item.marker.id?1.5:1});
      }
    }
    seriesMarkers.sort((a,b)=>a.time-b.time);markerPlugin.setMarkers(seriesMarkers);
  }
  function setMarkers(data,groupData){marks=Array.isArray(data)?data:[];if(groupData)groups=groupData;renderMarkers();}
  function setData(response){
    suppressRange=true;
    const key=(response.dataset?.id||response.dataset_id||'')+'|'+(response.timeframe||response.dataset?.period||'1m');
    const changed=key!==datasetKey,oldVisible=chart.timeScale().getVisibleRange();datasetKey=key;timeframe=response.timeframe||response.dataset?.period||'1m';
    rows=normalizeBars(response.bars);rowByTime=new Map(rows.map(row=>[row._time,row]));rowByDate=new Map(rows.filter(row=>row.trading_date).map(row=>[row.trading_date,row]));
    candles.setData(rows.map(row=>row._valid?{time:row._time,open:row.open,high:row.high,low:row.low,close:row.close,...(row.status==='partial'?{borderColor:'#b68a40',borderVisible:true,wickColor:'#b68a40',color:row.close>=row.open?'#77a99a':'#c89991'}:{})}:{time:row._time}));
    volume.setData(rows.map(row=>finite(row.volume)?{time:row._time,value:row.volume,color:row._valid?(row.close>=row.open?'#278b714d':'#cd62604d'):'#8b97a180'}:{time:row._time}));
    // Dataset time_zone describes the source, not the user's display preference.
    setTimezone(response.timeZone||timeZone);
    if(response.markers)marks=response.markers;if(response.groups)groups=response.groups;
    if(rows.length){
      if(changed||!oldVisible||response.resetView){
        let latest=rows.length-1;while(latest>=0&&!rows[latest]._valid)latest--;
        if(latest>=0)chart.timeScale().setVisibleLogicalRange({from:Math.max(-2,latest-179),to:latest+5});
        else{chart.timeScale().applyOptions({rightOffset:0});chart.timeScale().fitContent();}
      }
      else chart.timeScale().setVisibleRange(oldVisible);
    }
    renderMarkers();queueBands();
    requestAnimationFrame(()=>{suppressRange=false;});
  }
  function hover(param){
    if(destroyed)return;
    const row=typeof param.time==='number'?rowByTime.get(param.time):null;
    const payload=row?{bar:row,timeUtc:new Date(row._time*1000).toISOString()}:null;
    options.onHover?.(payload);
    if(options.detailElement){
      options.detailElement.textContent=row?`${fullTime(row._time)} · ${SESSION_LABELS[row.session]||'日线'} · 开 ${price(row.open)} 高 ${price(row.high)} 低 ${price(row.low)} 收 ${price(row.close)} · 量 ${finite(row.volume)?row.volume.toLocaleString('en-US'):'—'} · ${STATUS_LABELS[row.status]||row.status}${row.short_window?' · 短窗口':''}`:'移动光标查看价格与成交量';
    }
  }
  function click(param){
    if(destroyed||!param.point)return;
    const found=displayMarks.get(String(param.hoveredObjectId));
    if(found?.length){
      selectedId=found[0].id;renderMarkers();options.onMarkerClick?.({marker:found[0],markers:found,timeUtc:new Date(markerTime(found[0])*1000).toISOString()});return;
    }
    const row=typeof param.time==='number'?rowByTime.get(param.time):null;
    if(!row)return;
    (options.onBarClick||options.onTimeClick)?.({bar:row,timeUtc:new Date(row._time*1000).toISOString()});
  }
  function rangeChanged(range){
    queueBands();const nextDense=(chart.timeScale().options().barSpacing||6)<8;if(nextDense!==dense)renderMarkers();
    if(destroyed||suppressRange||!range||typeof range.from!=='number'||typeof range.to!=='number')return;
    const key=range.from+'|'+range.to;if(key===lastRangeKey)return;lastRangeKey=key;
    (options.onVisibleRangeChange||options.onRangeChange)?.({from:new Date(range.from*1000).toISOString(),to:new Date(range.to*1000).toISOString()});
  }
  function focusTime(value){
    const t=timestamp(value),row=rowAtTime(t);if(!row)return false;
    const index=rows.indexOf(row),half=Math.min(55,Math.max(12,Math.floor(rows.length/2)));
    chart.timeScale().setVisibleLogicalRange({from:Math.max(-2,index-half),to:Math.min(rows.length+5,index+half)});
    if(row._valid)chart.setCrosshairPosition(row.close,row._time,candles);queueBands();return true;
  }
  function reset(){chart.timeScale().applyOptions({rightOffset:0});chart.timeScale().fitContent();chart.priceScale('right').applyOptions({autoScale:true});queueBands();}
  const observer=new ResizeObserver(()=>{if(destroyed)return;chart.resize(Math.max(200,container.clientWidth),Math.max(240,container.clientHeight||480));queueBands();});observer.observe(container);
  chart.subscribeCrosshairMove(hover);chart.subscribeClick(click);chart.timeScale().subscribeVisibleTimeRangeChange(rangeChanged);
  setTimezone(timeZone);setTheme(document.documentElement.dataset.theme||'light');
  return {setData,setMarkers,setTimezone,setTheme,focus:focusTime,focusTime,reset,highlight(id){selectedId=id;renderMarkers();},destroy(){if(destroyed)return;destroyed=true;cancelAnimationFrame(frame);observer.disconnect();chart.unsubscribeCrosshairMove(hover);chart.unsubscribeClick(click);chart.timeScale().unsubscribeVisibleTimeRangeChange(rangeChanged);markerPlugin.detach();chart.remove();host.remove();bands.remove();}};
}
