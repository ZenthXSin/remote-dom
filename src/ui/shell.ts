export function initShell(){
 const themeButton=document.getElementById('theme-toggle');
 let theme='light';try{theme=localStorage.getItem('rd-theme')??'light';}catch{}
 const apply=()=>{document.body.dataset.theme=theme;themeButton?.setAttribute('aria-label',theme==='dark'?'切换浅色模式':'切换深色模式');if(themeButton)themeButton.textContent=theme==='dark'?'☀':'☾';};apply();
 themeButton?.addEventListener('click',()=>{theme=theme==='dark'?'light':'dark';apply();try{localStorage.setItem('rd-theme',theme);}catch{}});
 const menu=document.getElementById('menu-toggle');menu?.addEventListener('click',()=>{const open=document.querySelector('.app')?.classList.toggle('menu-open');menu.setAttribute('aria-expanded',String(!!open));});
 document.querySelectorAll('.sidebar a').forEach(link=>link.addEventListener('click',()=>{document.querySelector('.app')?.classList.remove('menu-open');menu?.setAttribute('aria-expanded','false');}));
}

export function passwordControls(){
 document.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(input=>{
  if(!input.hasAttribute('aria-label')){const label=input.closest('label');if(label)input.setAttribute('aria-label',label.textContent?.trim()??'密码');}
  const wrap=document.createElement('div');wrap.className='password-wrap';input.parentNode!.insertBefore(wrap,input);wrap.append(input);
  const button=document.createElement('button');button.type='button';button.className='password-toggle';button.textContent='显示';button.setAttribute('aria-label','显示密码');button.setAttribute('aria-pressed','false');button.addEventListener('click',()=>{const shown=input.type==='password';input.type=shown?'text':'password';button.textContent=shown?'隐藏':'显示';button.setAttribute('aria-label',shown?'隐藏密码':'显示密码');button.setAttribute('aria-pressed',String(shown));});wrap.append(button);
 });
}
