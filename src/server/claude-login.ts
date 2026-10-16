import type {BrowserContext,Page} from 'playwright-core';
import type {TargetPolicy} from './policy.js';

export class ClaudeLoginError extends Error {
  constructor(message:string,readonly status=400){super(message);}
}

export function parseClaudeSessionKey(value:unknown):string {
  if(typeof value!=='string'||value.length>4096)throw new ClaudeLoginError('请填写有效的 Claude sessionKey');
  const key=value.trim();
  if(!/^sk-ant-sid\d{2}-[A-Za-z0-9_-]{20,4000}$/.test(key))throw new ClaudeLoginError('请只粘贴 Claude sessionKey，不要填写 API Key、邮箱或整行账号信息');
  return key;
}

export async function importClaudeSession(value:unknown,context:Pick<BrowserContext,'addCookies'>,page:Pick<Page,'goto'>,policy:Pick<TargetPolicy,'assert'>,save?:()=>Promise<void>){
  const key=parseClaudeSessionKey(value);
  // Keep both destination and cookie scope fixed; honor the normal target policy.
  try{await policy.assert('https://claude.ai/');}catch{throw new ClaudeLoginError('当前浏览器环境未允许访问 Claude，请检查目标域名和网络设置',403);}
  try{await context.addCookies([{name:'sessionKey',value:key,domain:'.claude.ai',path:'/',secure:true,httpOnly:true,sameSite:'Lax'}]);}
  catch{throw new ClaudeLoginError('未能应用 Claude 登录凭据，请确认浏览器仍在运行后重试',502);}
  let navigation:'opened'|'incomplete'='opened';
  try{const response=await page.goto('https://claude.ai/',{waitUntil:'domcontentloaded',timeout:20000});if(!response||response.status()>=400)navigation='incomplete';}
  catch{navigation='incomplete';}
  let persistence:'saved'|'disabled'|'failed'=save?'saved':'disabled';
  if(save)try{await save();}catch{persistence='failed';}
  // Applying a cookie does not prove the upstream service accepted the session.
  return {applied:true as const,navigation,persistence};
}
