import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LoginTarget } from '../../ports/computer.ts';

export const loginInspectionSchema = z.object({
  origin: z.string().max(2048),
  url: z.string().max(8192),
  issue: z.literal('browser_not_supported').optional(),
  fields: z
    .array(
      z.object({
        kind: z.enum(['identifier', 'password', 'otp']),
        selector: z.string().min(1).max(500),
        label: z.string().max(100),
      }),
    )
    .max(20),
  methods: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        label: z.string().max(100),
        kind: z.enum(['credentials', 'oauth', 'passkey', 'manual']),
        supported: z.boolean(),
        reason: z.string().max(500).optional(),
        selector: z.string().max(500).optional(),
        group: z.string().max(100).optional(),
        selected: z.boolean().optional(),
      }),
    )
    .max(20),
  emailCode: z
    .object({
      recipient: z.email().max(320).optional(),
      recipientHint: z.string().min(3).max(320).optional(),
      length: z.number().int().min(4).max(8).optional(),
    })
    .optional(),
});

export const loginTargetScript = `
  const root=document.documentElement;
  const registry=root.__ottoLoginTargets??=new Map();
  const visible=e=>e && e.isConnected && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && getComputedStyle(e).display!=='none' && !e.closest('[hidden],[aria-hidden="true"],[inert]');
  const available=e=>visible(e)&&!e.matches(':disabled')&&!e.closest('[aria-disabled="true"]');
  const input=e=>e?.matches('input')&&['text','email','tel','password','number','search'].includes(e.type);
  const form=e=>e.form||e.closest('form');
  const sameForm=nodes=>nodes.every(e=>form(e)===form(nodes[0]));
  const canonical=selector=>/^input\\[data-otto-login-target="([a-zA-Z0-9_-]+)"\\]$/.exec(selector||'')?.[1];
  const resolve=selector=>{
    if(!selector||typeof selector!=='string'||selector.length>500) return [];
    let nodes;
    try { nodes=[...document.querySelectorAll(selector)]; } catch { return []; }
    const token=canonical(selector)||/^input\\[data-otto-login-node="([a-zA-Z0-9_-]+)"\\]$/.exec(selector)?.[1];
    if(/data-otto-login-(?:target|node)/.test(selector)&&!token) return [];
    if(token) {
      const captured=registry.get(token);
      if(!captured||nodes.length!==captured.length||nodes.some((e,i)=>e!==captured[i])) return [];
      return nodes;
    }
    return nodes.length>1?nodes.filter(available):nodes;
  };
  const split=nodes=>nodes.length>=4&&nodes.length<=8&&nodes.every(e=>input(e)&&available(e)&&e.maxLength===1&&['text','tel','number'].includes(e.type)&&e.parentElement===nodes[0].parentElement)&&[...nodes[0].parentElement.querySelectorAll('input')].filter(available).length===nodes.length;
  const valid=(nodes,kind)=>nodes.length>0&&(nodes.length===1||(kind==='otp'&&split(nodes)))&&nodes.every(e=>input(e)&&available(e)&&(kind==='password'?e.type==='password':e.type!=='password'))&&sameForm(nodes);
  const bind=(nodes,marker)=>{
    const existing=nodes[0]?.getAttribute('data-otto-login-target');
    const previous=existing&&registry.get(existing);
    const token=previous&&previous.length===nodes.length&&previous.every((e,i)=>e===nodes[i])?existing:marker;
    registry.set(token,nodes);
    for(const e of nodes) e.setAttribute('data-otto-login-target',token);
    return 'input[data-otto-login-target="'+token+'"]';
  };
`;

export function loginInspectionScript(target?: LoginTarget, marker = randomUUID()): string {
  return `(() => {
    ${loginTargetScript}
    const target=${JSON.stringify(target ?? null)},marker=${JSON.stringify(marker)};
    const result={origin:location.origin,url:location.href,fields:[],methods:[]};
    if(target&&target.origin!==location.origin) return result;
    const labels={identifier:'Account',password:'Password',otp:'Verification code'};
    const selected=[];
    if(target) {
      const requests=target.kind==='identifier'?[{kind:'identifier',selector:target.usernameSelector}]:[...(target.kind==='password'&&target.usernameSelector?[{kind:'identifier',selector:target.usernameSelector}]:[]),{kind:target.kind,selector:target.passwordSelector}];
      for(const request of requests) {
        let nodes=resolve(request.selector);
        if(request.kind==='otp'&&nodes.length===1&&nodes[0].maxLength===1&&!canonical(request.selector)) {
          const siblings=[...nodes[0].parentElement.querySelectorAll('input')].filter(available);
          if(split(siblings)) nodes=siblings;
        }
        if(!valid(nodes,request.kind)) return result;
        selected.push({...request,nodes});
      }
      const nodes=selected.flatMap(field=>field.nodes);
      if(new Set(nodes).size!==nodes.length||!sameForm(nodes)) return result;
    } else {
      const seen=new Set();
      for(const e of document.querySelectorAll('input')) {
        if(seen.has(e)||!input(e)||!available(e)||e.readOnly) continue;
        const autocomplete=(e.autocomplete||'').split(/\\s+/).at(-1);
        const kind=e.type==='password'?'password':autocomplete==='one-time-code'?'otp':autocomplete==='username'?'identifier':null;
        if(kind) {
          const siblings=kind==='otp'&&e.maxLength===1?[...e.parentElement.querySelectorAll('input')].filter(available):[];
          const nodes=split(siblings)?siblings:[e];
          nodes.forEach(node=>seen.add(node));
          selected.push({kind,nodes});
        }
      }
      if(selected.length>20) return result;
    }
    for(const [index,field] of selected.entries()) {
      const selector=bind(field.nodes,marker+'-'+index);
      for(const e of field.nodes) e.setAttribute('data-otto-login-field',field.kind+'-'+index);
      result.fields.push({kind:field.kind,selector,label:labels[field.kind]});
    }
    if(target?.kind==='otp'&&target.emailCode&&selected.length===1) {
      const nodes=selected[0].nodes;
      const scope=form(nodes[0])||document.body;
      const walker=scope&&document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);
      let text='',visited=0;
      while(walker&&visited++<1000&&text.length<4000&&walker.nextNode()) {
        const node=walker.currentNode,parent=node.parentElement;
        if(visible(parent)&&!parent.closest('script,style,noscript,textarea')) text+=' '+(node.textContent||'').slice(0,4000-text.length);
      }
      const recipients=[...new Set((text.match(/[a-z0-9._%+*•-]+@[a-z0-9.*•-]+\\.[a-z*•]{2,}/gi)||[]).map(value=>value.toLowerCase()))];
      if(recipients.length<=1) {
        const recipient=recipients[0];
        const length=nodes.length>1?nodes.length:nodes[0].maxLength;
        result.emailCode={...(recipient&&recipient.length<=320?(/[*•]/.test(recipient)?{recipientHint:recipient}:{recipient}):{}),...(length>=4&&length<=8?{length}:{})};
      }
    }
    return result;
  })()`;
}

export function loginReferenceScript(marker: string): string {
  return `(() => {
    ${loginTargetScript}
    const inputs=[...document.querySelectorAll('input')];
    let index=0;
    for(const e of inputs) if(input(e)&&available(e)) {
      const old=e.getAttribute('data-otto-login-node');
      const token=old&&registry.get(old)?.[0]===e?old:${JSON.stringify(marker)}+'-'+index++;
      registry.set(token,[e]);
      e.setAttribute('data-otto-login-node',token);
    }
    const sources=[...new Set(inputs.flatMap(e=>[e,...(e.labels||[]),...(e.getAttribute('aria-labelledby')||'').split(/\\s+/).map(id=>document.getElementById(id)),...(e.getAttribute('aria-describedby')||'').split(/\\s+/).map(id=>document.getElementById(id))]).filter(Boolean))];
    root.__ottoLoginObserver?.disconnect();
    root.__ottoLoginChanges=records=>{
      if(records.some(record=>record.type==='childList'||['id','for','role'].includes(record.attributeName)||record.target.matches?.('input,textarea,select,button,label')||sources.some(source=>source===record.target||source.contains(record.target)||record.target.contains?.(source)))) root.__ottoLoginChanged=true;
    };
    root.__ottoLoginChanged=false;
    const observer=root.__ottoLoginObserver=new MutationObserver(root.__ottoLoginChanges);
    observer.observe(root,{subtree:true,childList:true,attributes:true,characterData:true});
    return true;
  })()`;
}

export const loginReferencesStableScript = `(() => {
  const root=document.documentElement,observer=root.__ottoLoginObserver;
  if(!observer) return false;
  root.__ottoLoginChanges(observer.takeRecords());
  const changed=root.__ottoLoginChanged;
  observer.disconnect();
  return !changed;
})()`;
