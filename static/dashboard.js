const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { memories: [], selectedFile: null, recorder: null, stream: null, chunks: [], timer: null, startedAt: 0, recordingUrl: null, month: new Date(), selectedDay: new Date(), chat: [], showAll: false };

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function toast(message, error=false) { const el=$('#toast'); el.textContent=message; el.classList.toggle('error',error); el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.hidden=true,3500); }
function formatDate(value, options={month:'short',day:'numeric',year:'numeric'}) { const date=new Date(value); return Number.isNaN(date.valueOf())?'':new Intl.DateTimeFormat(undefined,options).format(date); }
function dateKey(value) { const d=value instanceof Date?value:new Date(value); if(Number.isNaN(d.valueOf()))return ''; return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function openModal(id) { $(`#${id}`).hidden=false; document.body.style.overflow='hidden'; }
function closeModal(id) { $(`#${id}`).hidden=true; if(!$$('.overlay:not([hidden])').length)document.body.style.overflow=''; }
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>closeModal(button.dataset.close)));
$$('.overlay').forEach(overlay=>overlay.addEventListener('click',e=>{if(e.target===overlay && overlay.id!=='process-overlay')closeModal(overlay.id)}));
$$('[data-scroll]').forEach(button=>button.addEventListener('click',()=>{document.getElementById(button.dataset.scroll)?.scrollIntoView({behavior:'smooth',block:'start'}); $$('.nav-button').forEach(item=>item.classList.toggle('active',item===button));}));

async function loadAll() { await Promise.all([loadMemories(),loadGraph()]); }
async function loadMemories() {
  try { const response=await fetch('/api/memories?limit=200'); if(!response.ok)throw new Error('Could not load memories'); state.memories=(await response.json()).memories||[]; renderMemories(); renderCalendar(); }
  catch(error){ $('#memory-list').innerHTML=`<div class="card empty-card">${escapeHtml(error.message)}</div>`; }
}
function filteredMemories(){ const q=$('#memory-search').value.trim().toLowerCase(); return q?state.memories.filter(m=>`${m.title} ${m.summary} ${(m.tags||[]).join(' ')}`.toLowerCase().includes(q)):state.memories; }
function renderMemories(){ const list=$('#memory-list'); const matches=filteredMemories(); const visible=state.showAll?matches:matches.slice(0,5); $('#view-all').textContent=state.showAll?'Show less':`View all (${matches.length})`; if(!visible.length){list.innerHTML='<div class="card empty-card">No memories match this search.</div>';return;} list.innerHTML=visible.map(m=>`<button class="card memory-card" data-memory-id="${escapeHtml(m.memory_id)}"><div class="memory-card-head"><div style="display:flex;gap:12px"><span class="memory-icon">▤</span><div><h3>${escapeHtml(m.title)}</h3><time>${escapeHtml(formatDate(m.created_at))}</time></div></div><span class="count-pill">${escapeHtml(m.language||'note')}</span></div><p>${escapeHtml(m.summary||'Open this memory to see the details.')}</p><div class="tags">${(m.tags||[]).slice(0,5).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}</div></button>`).join(''); $$('.memory-card').forEach(button=>button.addEventListener('click',()=>openMemory(button.dataset.memoryId))); }
$('#memory-search').addEventListener('input',renderMemories); $('#view-all').addEventListener('click',()=>{state.showAll=!state.showAll;renderMemories()}); $('#refresh-button').addEventListener('click',()=>{loadAll();toast('Memory refreshed')});

async function openMemory(id){ try{const response=await fetch(`/api/memories/${encodeURIComponent(id)}`);const data=await response.json();if(!response.ok)throw new Error(data.detail||'Could not open memory');const n=data.notes||{};$('#detail-title').textContent=n.title||data.source_name||'Untitled memory';$('#detail-date').textContent=formatDate(data.created_at);$('#detail-summary').textContent=n.summary||'No summary.';$('#detail-tags').innerHTML=(n.tags||[]).map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('');fillList('#detail-points',n.key_points,'No key points detected.');fillList('#detail-decisions',n.decisions,'No decisions detected.');$('#detail-actions').innerHTML=(n.action_items||[]).length?n.action_items.map(a=>`<div class="action-item"><strong>${escapeHtml(a.action)}</strong><span class="action-meta">${escapeHtml(a.owner)} · ${escapeHtml(a.deadline)}</span></div>`).join(''):'<p class="empty-copy">No action items detected.</p>';$('#detail-transcript').textContent=data.transcript||'';openModal('detail-modal');}catch(error){toast(error.message,true)} }
function fillList(selector,items,empty){$(selector).innerHTML=(items||[]).length?items.map(v=>`<li>${escapeHtml(v)}</li>`).join(''):`<li>${escapeHtml(empty)}</li>`;}

function renderCalendar(){ const view=new Date(state.month.getFullYear(),state.month.getMonth(),1); $('#calendar-month').textContent=formatDate(view,{month:'long',year:'numeric'}); const first=(view.getDay()+6)%7; const start=new Date(view);start.setDate(1-first);const memoryDates=new Set(state.memories.map(m=>dateKey(m.created_at)));let html='';for(let i=0;i<42;i++){const day=new Date(start);day.setDate(start.getDate()+i);const key=dateKey(day);const outside=day.getMonth()!==view.getMonth();const has=memoryDates.has(key);const today=key===dateKey(new Date());const selected=key===dateKey(state.selectedDay);html+=`<button class="calendar-day ${outside?'outside':''} ${has?'has-note':''} ${today?'today':''} ${selected?'selected':''}" data-date="${key}" ${has?'':'disabled'}>${day.getDate()}</button>`;}$('#calendar-days').innerHTML=html;const monthCount=state.memories.filter(m=>{const d=new Date(m.created_at);return d.getFullYear()===view.getFullYear()&&d.getMonth()===view.getMonth()}).length;$('#journal-count').textContent=`${monthCount} note${monthCount===1?'':'s'}`;$$('.calendar-day.has-note').forEach(button=>button.addEventListener('click',()=>{const [y,m,d]=button.dataset.date.split('-').map(Number);state.selectedDay=new Date(y,m-1,d);renderCalendar();renderDayNotes()}));renderDayNotes(); }
function renderDayNotes(){const key=dateKey(state.selectedDay);const notes=state.memories.filter(m=>dateKey(m.created_at)===key);$('#selected-day-title').textContent=formatDate(state.selectedDay,{month:'short',day:'numeric'});$('#selected-day-count').textContent=String(notes.length);$('#selected-day-list').innerHTML=notes.length?notes.map(m=>`<button class="mini-note" data-memory-id="${escapeHtml(m.memory_id)}"><strong>${escapeHtml(m.title)}</strong><p>${escapeHtml(m.summary)}</p></button>`).join(''):'<p class="empty-copy">No saved memories on this day.</p>';$$('.mini-note').forEach(button=>button.addEventListener('click',()=>openMemory(button.dataset.memoryId)));}
$('#prev-month').addEventListener('click',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()-1,1);renderCalendar()});$('#next-month').addEventListener('click',()=>{state.month=new Date(state.month.getFullYear(),state.month.getMonth()+1,1);renderCalendar()});

async function loadGraph(){try{const response=await fetch('/api/graph');if(!response.ok)throw new Error();const graph=await response.json();$('#graph-count').textContent=`${graph.edge_count||0} links`;const nodes=(graph.nodes||[]).filter(n=>n.type!=='memory').slice(0,18);$('#graph-cloud').innerHTML=nodes.length?nodes.map(n=>`<span class="graph-node ${escapeHtml(n.type)}">${escapeHtml(n.label)}</span>`).join(''):'<p class="empty-copy">Connections will grow with every note.</p>';const labels=Object.fromEntries((graph.nodes||[]).map(n=>[n.id,n.label]));const edge=(graph.edges||[]).find(e=>e.relation!=='mentions');$('#graph-relation').textContent=edge?`${labels[edge.source]||edge.source} → ${edge.relation} → ${labels[edge.target]||edge.target}`:'';}catch(_){$('#graph-count').textContent='0 links';}}

function recordingType(){return ['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t))||''}function extensionFor(type){return type.includes('mp4')?'m4a':type.includes('ogg')?'ogg':'webm'}
function updateClock(){const seconds=Math.floor((Date.now()-state.startedAt)/1000);$('#record-time').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function releaseMic(){if(state.stream)state.stream.getTracks().forEach(t=>t.stop());state.stream=null;}
$('#record-button').addEventListener('click',async()=>{if(state.recorder?.state==='recording'){state.recorder.stop();return;}if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return toast('This browser does not support recording.',true);try{state.stream=await navigator.mediaDevices.getUserMedia({audio:true});state.chunks=[];const type=recordingType();state.recorder=type?new MediaRecorder(state.stream,{mimeType:type}):new MediaRecorder(state.stream);state.recorder.addEventListener('dataavailable',e=>{if(e.data.size)state.chunks.push(e.data)});state.recorder.addEventListener('stop',finishRecording);state.recorder.start(1000);state.startedAt=Date.now();updateClock();state.timer=setInterval(updateClock,1000);$('.recorder-card').classList.add('recording');$('#record-title').textContent='Listening… tap to stop';$('#record-help').textContent='Your microphone is active';}catch(error){releaseMic();toast(error.name==='NotAllowedError'?'Microphone permission was denied.':error.message,true)}});
function finishRecording(){clearInterval(state.timer);$('.recorder-card').classList.remove('recording');$('#record-title').textContent='Recording ready';$('#record-help').textContent='Preview or add it to your second brain';const type=state.recorder.mimeType||'audio/webm';const blob=new Blob(state.chunks,{type});const name=`voice-note-${new Date().toISOString().replace(/[:.]/g,'-')}.${extensionFor(type)}`;state.selectedFile=new File([blob],name,{type});if(state.recordingUrl)URL.revokeObjectURL(state.recordingUrl);state.recordingUrl=URL.createObjectURL(blob);$('#recorded-audio').src=state.recordingUrl;$('#download-recording').href=state.recordingUrl;$('#download-recording').download=name;$('#record-preview').hidden=false;releaseMic();if(window.confirm('Recording stopped. Add this audio to your second brain now?'))processAudio(state.selectedFile);}
$('#file-input').addEventListener('change',e=>{const file=e.target.files[0];if(file)processAudio(file);e.target.value=''});
function statusProgress(status){return {uploading:12,uploaded:25,transcribing:58,generating_summary:80,saving_memory:94,complete:100}[status]||18;}
async function processAudio(file){openModal('process-overlay');$('#status-text').textContent='Uploading audio';$('#progress-fill').style.width='10%';try{const form=new FormData();form.append('file',file);const response=await fetch('/api/process',{method:'POST',body:form});const data=await response.json();if(!response.ok)throw new Error(data.detail||'Upload failed');await watchJob(data.job_id);}catch(error){closeModal('process-overlay');toast(error.message,true)}}
async function watchJob(id){while(true){const response=await fetch(`/api/status/${id}`);const data=await response.json();if(!response.ok)throw new Error(data.detail||'Could not read job status');$('#status-text').textContent=data.message||data.status;$('#progress-fill').style.width=`${statusProgress(data.status)}%`;if(data.status==='complete'){await loadAll();closeModal('process-overlay');toast('Memory saved and indexed');if(data.result?.memory_id)openMemory(data.result.memory_id);return;}if(data.status==='error')throw new Error(data.message);await new Promise(r=>setTimeout(r,1000));}}

$('#new-note-button').addEventListener('click',()=>openModal('note-modal'));$('#top-new-note').addEventListener('click',()=>openModal('note-modal'));
$('#note-form').addEventListener('submit',async e=>{e.preventDefault();const button=$('#save-note');button.disabled=true;button.textContent='Ollama is understanding your note…';try{const response=await fetch('/api/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:$('#quick-title').value,content:$('#quick-content').value})});const data=await response.json();if(!response.ok)throw new Error(data.detail||'Could not save note');e.target.reset();closeModal('note-modal');await loadAll();toast('Text note saved to memory');if(data.memory_id)openMemory(data.memory_id);}catch(error){toast(error.message,true)}finally{button.disabled=false;button.innerHTML='Understand &amp; save to memory <span>→</span>';}});

function appendMessage(role,text,sources=[]){const el=document.createElement('div');el.className=`message ${role}`;el.textContent=text;if(sources.length){const row=document.createElement('div');row.className='chat-sources';sources.forEach(source=>{const b=document.createElement('button');b.textContent=source.title;b.addEventListener('click',()=>openMemory(source.memory_id));row.appendChild(b)});el.appendChild(row)}$('#chat-messages').appendChild(el);$('#chat-messages').scrollTop=$('#chat-messages').scrollHeight;return el;}
async function ask(question){question=question.trim();if(!question)return;appendMessage('user',question);state.chat.push({role:'user',content:question});const thinking=appendMessage('assistant','Searching and connecting your memories…');$('#chat-send').disabled=true;try{const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,history:state.chat.slice(0,-1).slice(-6)})});const data=await response.json();if(!response.ok)throw new Error(data.detail||'Could not answer');thinking.remove();appendMessage('assistant',data.answer,data.sources||[]);state.chat.push({role:'assistant',content:data.answer});}catch(error){thinking.textContent=error.message}finally{$('#chat-send').disabled=false}}
$('#chat-form').addEventListener('submit',e=>{e.preventDefault();const value=$('#chat-input').value;$('#chat-input').value='';ask(value)});$$('[data-question]').forEach(button=>button.addEventListener('click',()=>ask(button.dataset.question)));

document.addEventListener('keydown',e=>{if(e.key==='Escape')$$('.overlay:not([hidden])').filter(el=>el.id!=='process-overlay').forEach(el=>closeModal(el.id))});
loadAll();

let explorerGraph = null;
$('#open-graph').addEventListener('click', async () => {
  openModal('graph-modal');
  $('#graph-stage').classList.add('loading');
  try {
    const response = await fetch('/api/graph');
    if (!response.ok) throw new Error('Graph unavailable');
    explorerGraph = await response.json();
    renderInteractiveGraph(explorerGraph);
  } catch (_) {
    $('#selected-node-title').textContent = 'Could not load graph. Please retry.';
  } finally {
    $('#graph-stage').classList.remove('loading');
  }
});

function renderInteractiveGraph(graph) {
  const svg = $('#graph-svg');
  const stage = $('#graph-stage');
  const width = Math.max(520, stage.clientWidth || 760);
  const height = stage.clientHeight || 510;
  const nodes = graph.nodes || [];
  const nodeMap = Object.fromEntries(nodes.map(node => [node.id, node]));
  const edges = (graph.edges || []).filter(edge => nodeMap[edge.source] && nodeMap[edge.target]);
  const cx = width / 2, cy = height / 2;
  const positions = {};
  nodes.forEach((node, index) => {
    if (node.type === 'memory') {
      const memories = nodes.filter(item => item.type === 'memory');
      const memoryIndex = memories.indexOf(node);
      const angle = (memoryIndex / Math.max(1, memories.length)) * Math.PI * 2 - Math.PI / 2;
      positions[node.id] = { x: cx + Math.cos(angle) * Math.min(width, height) * .37, y: cy + Math.sin(angle) * Math.min(width, height) * .37 };
    } else {
      const entityIndex = nodes.filter(item => item.type !== 'memory').indexOf(node);
      const entityCount = Math.max(1, nodes.filter(item => item.type !== 'memory').length);
      const angle = (entityIndex / entityCount) * Math.PI * 2;
      const radius = Math.min(width, height) * (.13 + (entityIndex % 3) * .085);
      positions[node.id] = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
    }
  });
  // Relax a spring layout: stronger semantic similarity has a shorter rest length.
  for (let step=0; step<240; step++) {
    const forces = Object.fromEntries(nodes.map(n=>[n.id,{x:0,y:0}]));
    for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) {
      const a=positions[nodes[i].id],b=positions[nodes[j].id];
      const dx=a.x-b.x,dy=a.y-b.y,d=Math.max(1,Math.hypot(dx,dy));
      const f=Math.min(12,1800/(d*d));
      forces[nodes[i].id].x+=dx/d*f; forces[nodes[i].id].y+=dy/d*f;
      forces[nodes[j].id].x-=dx/d*f; forces[nodes[j].id].y-=dy/d*f;
    }
    for(const e of edges) {
      const a=positions[e.source],b=positions[e.target],dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy));
      const semantic=e.kind==='semantic',target=semantic?55+120*(1-e.similarity):130;
      const f=(d-target)*(semantic?.065:.018);
      forces[e.source].x+=dx/d*f;forces[e.source].y+=dy/d*f;
      forces[e.target].x-=dx/d*f;forces[e.target].y-=dy/d*f;
    }
    for(const n of nodes) {
      const p=positions[n.id],f=forces[n.id];
      p.x=Math.max(45,Math.min(width-45,p.x+(f.x+(cx-p.x)*.003)*.6));
      p.y=Math.max(40,Math.min(height-45,p.y+(f.y+(cy-p.y)*.003)*.6));
    }
  }
  $('#explorer-count').textContent = `${nodes.length} nodes · ${graph.semantic_count||0} semantic links`;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `${edges.map(edge => { const a=positions[edge.source], b=positions[edge.target]; return `<line class="graph-edge" data-source="${escapeHtml(edge.source)}" data-target="${escapeHtml(edge.target)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`; }).join('')}${nodes.map(node => { const p=positions[node.id]; const radius=node.type==='memory'?17:12; return `<g class="graph-svg-node ${escapeHtml(node.type)}" data-node-id="${escapeHtml(node.id)}" transform="translate(${p.x} ${p.y})"><circle r="${radius}"></circle><text y="${radius+15}">${escapeHtml(String(node.label).slice(0, 25))}</text></g>`; }).join('')}`;
  $$('.graph-svg-node').forEach(node => node.addEventListener('click', () => selectGraphNode(node.dataset.nodeId, graph, positions)));
  $$('.graph-edge').forEach((line,index)=>{
    const e=edges[index];line.classList.toggle('semantic',e.kind==='semantic');
    const title=document.createElementNS('http://www.w3.org/2000/svg','title');
    title.textContent=e.kind==='semantic'?`Similar meaning · cosine ${e.similarity} (estimated association)`:e.relation;
    line.appendChild(title);
  });
  $$('.graph-svg-node').forEach(node=>{
    node.setAttribute('tabindex','0');node.setAttribute('role','button');
    node.setAttribute('aria-label',nodeMap[node.dataset.nodeId].label);
    node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectGraphNode(node.dataset.nodeId,graph,positions)}});
  });
  if (nodes.length) selectGraphNode(nodes.find(node => node.type !== 'memory')?.id || nodes[0].id, graph, positions);
}

function selectGraphNode(nodeId, graph, positions) {
  const nodeMap = Object.fromEntries((graph.nodes || []).map(node => [node.id, node]));
  const selected = nodeMap[nodeId];
  if (!selected) return;
  const connectedEdges = (graph.edges || []).filter(edge => edge.source === nodeId || edge.target === nodeId);
  const connectedIds = new Set([nodeId,...connectedEdges.flatMap(edge => [edge.source, edge.target])]);
  $$('.graph-svg-node').forEach(node => { node.classList.toggle('selected', node.dataset.nodeId === nodeId); node.classList.toggle('dim', !connectedIds.has(node.dataset.nodeId)); });
  $$('.graph-edge').forEach(edge => edge.classList.toggle('active', edge.dataset.source === nodeId || edge.dataset.target === nodeId));
  $('#selected-node-title').textContent = selected.label || 'Untitled node';
  $('#selected-node-type').textContent = `${selected.type || 'concept'} · mentioned ${selected.count || 1} time${selected.count === 1 ? '' : 's'}`;
  const related = connectedEdges.map(edge => { const relatedId = edge.source === nodeId ? edge.target : edge.source; return { node: nodeMap[relatedId], relation: edge.kind==='semantic'?`Similar meaning · cosine ${edge.similarity}`:edge.relation }; }).filter(item => item.node && item.node.type !== 'memory');
  $('#selected-node-connections').innerHTML = related.length ? related.map(item => `<button class="connection-chip" data-related="${escapeHtml(item.node.id)}">${escapeHtml(item.node.label)}<br>${escapeHtml(item.relation)}</button>`).join('') : '<p class="empty-copy">No connected topics yet.</p>';
  $$('[data-related]').forEach(b=>b.addEventListener('click',()=>selectGraphNode(b.dataset.related,graph,positions)));
  const memoryIds = connectedEdges.map(edge => edge.source === nodeId ? edge.target : edge.source).filter(id => nodeMap[id]?.type === 'memory');
  const memoriesForNode = selected.sources || (selected.type==='memory'?[{memory_id:selected.memory_id,title:selected.label}]:memoryIds.map(id => state.memories.find(memory => memory.memory_id === nodeMap[id].memory_id)).filter(Boolean));
  $('#selected-node-memories').innerHTML = memoriesForNode.length ? memoriesForNode.map(memory => `<button class="inspector-memory" data-memory-id="${escapeHtml(memory.memory_id)}">${escapeHtml(memory.title)}<br><span>${escapeHtml(formatDate(memory.created_at))}</span></button>`).join('') : '<p class="empty-copy">No saved memory is linked yet.</p>';
  $$('.inspector-memory').forEach(button => button.addEventListener('click', () => { closeModal('graph-modal'); openMemory(button.dataset.memoryId); }));
}
