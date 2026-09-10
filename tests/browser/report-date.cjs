const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const TARGET_URL=process.env.MOMENTREAD_SCALE_URL||'http://127.0.0.1:4325';
const manifest=JSON.parse(fs.readFileSync(process.env.MOMENTREAD_SCALE_MANIFEST||'/tmp/momentread-browser-scale-manifest.json','utf8'));
const OUTPUT_DIR=process.env.MOMENTREAD_SCALE_OUTPUT||'/tmp/momentread-browser-scale-results';
(async()=>{
 const timezone='Pacific/Kiritimati';const checkedAt=new Date();
 const expectedDate=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(checkedAt);
 const response=await fetch(`${TARGET_URL}/api/books/${manifest.bookId}/report?timezone=${encodeURIComponent(timezone)}`);assert.equal(response.status,200);const report=await response.json();
 assert.equal(report.book.id,manifest.bookId);assert.equal(report.timezone,timezone);assert.equal(report.date,expectedDate);
 const result={synthetic:true,checkedAt:checkedAt.toISOString(),timezone,expectedDate,actualDate:report.date,status:'passed',realModelInvocations:0};
 fs.mkdirSync(OUTPUT_DIR,{recursive:true});fs.writeFileSync(path.join(OUTPUT_DIR,'default-report-date.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;});
