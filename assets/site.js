
const destinationHosts={n2:'architectura.asiwi.ru',homestaging:'homestaging.asiwi.ru'};
const liveDomain=location.hostname==='asiwi.ru'||location.hostname.endsWith('.asiwi.ru');
if(liveDomain){document.querySelectorAll('[data-destination]').forEach(a=>{const h=destinationHosts[a.dataset.destination];if(h)a.href='https://'+h+'/';});document.querySelectorAll('a[href="/"]').forEach(a=>a.href='https://asiwi.ru/');document.querySelectorAll('a[href^="/#"]').forEach(a=>a.href='https://asiwi.ru/'+a.getAttribute('href').slice(1));}
