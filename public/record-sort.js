export function sortRecords(records,field='buy_time',direction='desc'){
  const index=/^d(?:[0-9]|10)$/.test(field)?Number(field.slice(1)):null;
  const sign=direction==='asc'?1:-1;
  return records.slice().sort((a,b)=>{
    if(index===null){const compared=a.buy_time.localeCompare(b.buy_time);if(compared)return compared*sign;}
    else{
      const av=a.tracking?.window?.[index]?.value,bv=b.tracking?.window?.[index]?.value;
      const aMissing=typeof av!=='number'||!Number.isFinite(av),bMissing=typeof bv!=='number'||!Number.isFinite(bv);
      if(aMissing!==bMissing)return aMissing?1:-1;
      if(!aMissing&&av!==bv)return (av-bv)*sign;
    }
    return a.buy_time.localeCompare(b.buy_time)||String(a.id).localeCompare(String(b.id));
  });
}
