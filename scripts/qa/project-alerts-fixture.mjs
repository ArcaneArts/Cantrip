/** Helpers compiled only into the disposable browser QA build. */
export function projectAlertsFixturePlugin(token, seed) {
  return {
    name: "cantrip-qa-alerts",
    enforce: "pre",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/cantrip_app/src/main.tsx"))
        return null;
      return {
        code: `${source}
import { request as qaAlertRequest } from '@/lib/api-client';
import { clientEncryption as qaAlertEncryption } from '@/lib/client-encryption';
import { getClientSession as qaAlertSession } from '@/lib/client-session';
import { encryptInteractionRequestContent as qaSealInteraction, encryptTaskProtectedContent as qaSealTask, clearSensitiveBytes as qaClearBytes } from '@cantrip/crypto';
import { protectEndpointContent as qaSealEndpoint } from '@/lib/endpoint-content-encryption';
import { projectAlertDetailSchema as qaAlertDetailSchema } from '@cantrip/protocol';
import { protectChatGoalObjective as qaSealGoal } from '@/lib/chat-message-encryption';
import { respondToAgentInteractionRequest as qaRespond } from '@/lib/api';
import { createEncryptedAgentInteractionResponse as qaSealResponse } from '@/lib/interaction-encryption';
import { createGithubProject as qaAlertCreateProject } from '@/lib/project-encryption';
import { prepareConversationCreation as qaAlertPrepareChat } from '@/lib/api/conversations';
const qaAlertContexts = new Map();
const qaAlertRequests = new Map();
async function qaAlertControl(input) {
  return qaAlertRequest('/api/__qa/alerts', {method:'POST',headers:{'x-cantrip-qa':${JSON.stringify(token)}},body:JSON.stringify(input)});
}
function qaAlertKey(component) {
  const session=qaAlertSession(); const snapshot=qaAlertEncryption.getSnapshot();
  return {session,snapshot,key:qaAlertEncryption.componentKey({component,identity:snapshot.identity,keyRevision:snapshot.masterKeyRevision})};
}
globalThis.__qaAlerts = {
  async backgroundProject() {return qaAlertCreateProject(${JSON.stringify(seed.input)});},
  async chat(projectId, title) {return (await qaAlertPrepareChat(projectId,title,false))();},
  control:qaAlertControl,
  async prepare(chatId, execute=true) { const c=await qaAlertControl({op:'prepare',chatId,execute});qaAlertContexts.set(chatId,c);return c; },
  async interaction(chatId, kind='fileChange', requestKey=crypto.randomUUID()) {
    if(qaAlertRequests.has(requestKey))return qaAlertControl(qaAlertRequests.get(requestKey));
    const {session,snapshot,key}=qaAlertKey('interaction-content');
    const classification={kind};
    const payload=kind==='fileChange' ? {kind,startedAtMs:Date.now(),reason:'QA private change requires your decision',grantRoot:'/disposable/project'}
      : {kind:'userInput',questions:[{id:'choice',header:'Deployment',question:'QA private question: which environment?',isOther:false,isSecret:false,options:[{label:'Staging',description:'Disposable test'}]}],autoResolutionMs:null};
    try { const protectedPayload=await qaSealInteraction({ownerId:session.user.id,requestKey,keyRevision:snapshot.masterKeyRevision,componentKey:key,content:{version:1,classification,payload}});
      const input={op:'interaction',chatId,requestKey,classification,protectedPayload};
      qaAlertRequests.set(requestKey,input);return qaAlertControl(input);
    } finally {qaClearBytes(key);}
  },
  respond:qaRespond,
  async responseWire(id) {
    const request=await qaAlertRequest('/api/agent-requests/'+id);
    return {csrf:qaAlertSession().csrfToken,body:await qaSealResponse(request,{idempotencyKey:crypto.randomUUID(),response:{kind:'fileChange',decision:'accept'}})};
  },
  async counts() {return qaAlertRequest('/api/project-alerts/counts');},
  async list(projectId) {return qaAlertRequest('/api/projects/'+projectId+'/alerts');},
  async agent(chatId, key=crypto.randomUUID(), revision=1, status='open') {
    const c=qaAlertContexts.get(chatId);const session=qaAlertSession();
    const context={domain:'alert-content',serverId:session.serverId,workerId:c.workerId,scopeId:chatId,operation:'agent-alert',operationId:key,direction:'stored',sequence:revision};
    const protectedContent=await qaSealEndpoint({context,content:{title:'QA agent needs a decision',message:'QA private blocker: deployment credentials are missing.',nextStep:'Provide disposable credentials in the originating chat.'},schema:qaAlertDetailSchema});
    return qaAlertControl({op:'agent',chatId,mutation:{key,revision,kind:'blocked',status,protectedDetail:{context,protectedContent}}});
  },
  async goal(chatId, status, revision) {
    const c=qaAlertContexts.get(chatId);
    const goal=status ? {threadId:c.threadId,status,tokenBudget:1000,tokensUsed:10,timeUsedSeconds:1,createdAt:1,updatedAt:revision,protectedObjective:await qaSealGoal('QA private Goal objective')} : null;
    return qaAlertControl({op:'goal',chatId,revision,snapshot:{kind:'chat-encrypted',goal}});
  },
  async task(chatId, state='review', questions=true) {
    const {session,snapshot,key}=qaAlertKey('task-content');
    const classification={state,stableStateBeforeFailure:null,activeOperationKind:null,planAuthorship:'agent',planningRound:1,hasPlan:true,hasQuestions:questions,hasFinalPlan:false,hasGoalPrompt:false,lastError:null};
    const content={version:1,classification,briefMarkdown:'QA private task brief',planMarkdown:'QA private plan: validate the Alert Inbox',currentQuestions:questions?[{id:'target',header:'Target',question:'Which QA target?',options:[{id:'staging',label:'Staging',description:'Disposable test'}],recommendedOptionId:'staging',allowFreeform:true,required:true}]:[],currentAnswers:[],additionalDirection:'',finalPlanMarkdown:null,goalPrompt:null,lastError:null};
    try {return qaAlertControl({op:'task',chatId,content:{classification,protectedContent:await qaSealTask({ownerId:session.user.id,chatId,keyRevision:snapshot.masterKeyRevision,componentKey:key,content})}});}finally{qaClearBytes(key);}
  },
};
if(import.meta.env.VITE_CANTRIP_ALERTS_NATIVE_QA === 'true') {
  void import('@tauri-apps/api/window').then(({getCurrentWindow})=>{
    if(getCurrentWindow().label!=='main')return;
    const button=document.createElement('button');button.textContent='QA create background Alert';
    button.style.cssText='position:fixed;bottom:8px;left:8px;z-index:2147483647;background:#222;color:white;padding:8px';
    button.onclick=()=>{button.disabled=true;void(async()=>{
      await globalThis.__qaRepositoryFixture.create();
      const project=await globalThis.__qaAlerts.backgroundProject();
      let chat;const deadline=Date.now()+90000;
      while(!chat){try{chat=await globalThis.__qaAlerts.chat(project.id,'Background builder');}catch(e){if(Date.now()>deadline||!String(e).includes('No online worker'))throw e;await new Promise(r=>setTimeout(r,500));}}
      await globalThis.__qaAlerts.prepare(chat.id);await globalThis.__qaAlerts.interaction(chat.id);
      button.textContent='QA Alert ready in Alerts-Background-QA';
      console.log('QA_EVT '+JSON.stringify({event:'native.alert.ready',status:'pass',projectId:project.id}));
    })().catch(e=>{button.textContent=String(e);button.disabled=false;});};
    document.body.append(button);
  });
}
`,
      };
    },
  };
}
