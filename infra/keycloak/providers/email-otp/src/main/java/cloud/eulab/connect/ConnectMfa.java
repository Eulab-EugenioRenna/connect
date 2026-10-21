package cloud.eulab.connect;
import java.util.Map;
import java.util.List;
import jakarta.ws.rs.core.Cookie;
import jakarta.ws.rs.core.NewCookie;
import jakarta.ws.rs.core.Response;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.browser.AbstractUsernameFormAuthenticator;
import org.keycloak.credential.CredentialModel;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.*;
import org.keycloak.util.JsonSerialization;

/** Runs REQUIRED after primary authentication; never authenticates an unknown user. */
public final class ConnectMfa extends AbstractUsernameFormAuthenticator implements Authenticator {
 private static final String TYPE="eulab-trusted-device", PREFIX="eulab.mfa.", COOKIE="EULAB_TRUSTED_";
 private static final int TRUST_SECONDS=30*24*60*60;
 private boolean totp(AuthenticationFlowContext c){return c.getUser().credentialManager().isConfiguredFor("otp");}
 private boolean email(AuthenticationFlowContext c){return c.getRealm().getSmtpConfig().get("host")!=null&&c.getUser().isEmailVerified()&&c.getUser().getEmail()!=null&&!c.getUser().getEmail().isBlank();}
 private String note(AuthenticationFlowContext c,String key){return c.getAuthenticationSession().getAuthNote(PREFIX+key);}
 private void note(AuthenticationFlowContext c,String key,String value){c.getAuthenticationSession().setAuthNote(PREFIX+key,value);}
 private long number(AuthenticationFlowContext c,String key){try{return Long.parseLong(note(c,key));}catch(Exception e){return 0;}}
 private String cookieName(AuthenticationFlowContext c){return COOKIE+SecurityTokens.digest(c.getRealm().getId()).substring(0,12);}
 private boolean secure(AuthenticationFlowContext c){return "https".equalsIgnoreCase(c.getUriInfo().getBaseUri().getScheme());}
 private Map<?,?> data(String json){try{var result=JsonSerialization.readValue(json,Map.class);return result==null?Map.of():result;}catch(Exception e){return Map.of();}}
 private boolean trusted(AuthenticationFlowContext c){
  if(!secure(c))return false;
  Cookie cookie=c.getHttpRequest().getHttpHeaders().getCookies().get(cookieName(c));if(cookie==null)return false;
  String[] parts=cookie.getValue().split("\\.",2);if(parts.length!=2||parts[1].length()!=43)return false;
  CredentialModel cred=c.getUser().credentialManager().getStoredCredentialById(parts[0]);
  if(cred==null||!TYPE.equals(cred.getType()))return false;
  Object expires=data(cred.getCredentialData()).get("expiresAt"),hash=data(cred.getSecretData()).get("hash");
  return expires instanceof Number&&((Number)expires).longValue()>System.currentTimeMillis()&&hash instanceof String&&SecurityTokens.matches((String)hash,SecurityTokens.digest(parts[1]));
 }
 private Response form(AuthenticationFlowContext c,String error){
  var f=c.form().setAttribute("totpAvailable",totp(c)).setAttribute("emailAvailable",email(c)).setAttribute("emailMode","email".equals(note(c,"mode"))).setAttribute("trustAvailable",secure(c));
  if(error!=null)f.setError(error);return f.createForm("connect-mfa.ftl");
 }
 @Override protected Response createLoginForm(LoginFormsProvider form){return form.createForm("connect-mfa.ftl");}
 @Override public void authenticate(AuthenticationFlowContext c){
  if(!enabledUser(c,c.getUser()))return;
  if(trusted(c)){c.success(TYPE);return;}
  if(!totp(c)&&!email(c)){
   // Native required action verifies a freshly configured TOTP before issuing the session.
   c.getUser().addRequiredAction(UserModel.RequiredAction.CONFIGURE_TOTP);c.success();return;
  }
  if(note(c,"mode")==null){
   String preferred=c.getUser().getFirstAttribute("eulab.mfa.preferredMethod");
   note(c,"mode","email".equals(preferred)&&email(c)?"email":totp(c)?"totp":"email");
  }
  c.challenge(form(c,null));
 }
 private void clearCode(AuthenticationFlowContext c){for(String key:List.of("hash","salt","expires","recipient"))c.getAuthenticationSession().removeAuthNote(PREFIX+key);}
 private void send(AuthenticationFlowContext c){
  if(!email(c)){c.challenge(form(c,"connectEmailUnavailable"));return;}
  note(c,"mode","email");long now=System.currentTimeMillis();
  if(number(c,"lastSend")+60_000>now||number(c,"sends")>=3){c.challenge(form(c,"connectWait"));return;}
  clearCode(c);String code=SecurityTokens.code(),salt=SecurityTokens.token();
  // Reserve before SMTP: an ambiguous transport error never causes an automatic resend.
  note(c,"lastSend",Long.toString(now));note(c,"sends",Long.toString(number(c,"sends")+1));
  try{
   c.getSession().getProvider(EmailTemplateProvider.class).setRealm(c.getRealm()).setUser(c.getUser()).setAuthenticationSession(c.getAuthenticationSession()).send("connectOtpSubject","connect-otp.ftl",Map.of("code",code,"minutes",5));
   note(c,"salt",salt);note(c,"hash",SecurityTokens.digest(salt+code));note(c,"expires",Long.toString(now+300_000));note(c,"recipient",c.getUser().getEmail());
   c.challenge(form(c,null));
  }catch(Exception e){clearCode(c);c.challenge(form(c,"connectSendFailed"));}
 }
 private void remember(AuthenticationFlowContext c,String name){
  if(!secure(c))return;
  var manager=c.getUser().credentialManager();long now=System.currentTimeMillis();
  // Remove expired credentials and cap storage per identity.
  var existing=manager.getStoredCredentialsByTypeStream(TYPE).toList();
  for(var credential:existing){Object expiry=data(credential.getCredentialData()).get("expiresAt");if(!(expiry instanceof Number)||((Number)expiry).longValue()<=now)manager.removeStoredCredentialById(credential.getId());}
  if(manager.getStoredCredentialsByTypeStream(TYPE).count()>=20)return;
  String token=SecurityTokens.token();CredentialModel credential=new CredentialModel();credential.setType(TYPE);credential.setCreatedDate(now);
  credential.setUserLabel(name==null||name.isBlank()?"Dispositivo attendibile":name.strip().substring(0,Math.min(name.strip().length(),80)));
  credential.setCredentialData("{\"expiresAt\":"+(now+TRUST_SECONDS*1000L)+"}");credential.setSecretData("{\"hash\":\""+SecurityTokens.digest(token)+"\"}");
  credential=manager.createStoredCredential(credential);
  String path=c.getUriInfo().getBaseUri().getPath()+"realms/"+c.getRealm().getName()+"/";
  c.getSession().getContext().getHttpResponse().setCookieIfAbsent(new NewCookie.Builder(cookieName(c)).value(credential.getId()+"."+token).path(path).httpOnly(true).secure(true).sameSite(NewCookie.SameSite.LAX).maxAge(TRUST_SECONDS).build());
 }
 @Override public void action(AuthenticationFlowContext c){
  if(!enabledUser(c,c.getUser()))return;
  var input=c.getHttpRequest().getDecodedFormParameters();String action=input.getFirst("action");
  if("cancel".equals(action)){clearCode(c);c.cancelLogin();return;}
  if(number(c,"attempts")>=5){clearCode(c);c.failure(AuthenticationFlowError.INVALID_CREDENTIALS);return;}
  if("send-email".equals(action)){send(c);return;}
  if("use-totp".equals(action)&&totp(c)){note(c,"mode","totp");c.challenge(form(c,null));return;}
  String code=input.getFirst("otp");boolean valid;
  if("email".equals(note(c,"mode"))){valid=email(c)&&c.getUser().getEmail().equals(note(c,"recipient"))&&SecurityTokens.validCode(code,note(c,"salt"),note(c,"hash"),number(c,"expires"),(int)number(c,"attempts"),System.currentTimeMillis());}
  else{valid=totp(c)&&code!=null&&code.matches("[0-9]{6}")&&c.getUser().credentialManager().getStoredCredentialsByTypeStream("otp").anyMatch(credential -> c.getUser().credentialManager().isValid(new UserCredentialModel(credential.getId(),"otp",code)));}
  if(!valid){note(c,"attempts",Long.toString(number(c,"attempts")+1));c.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS,form(c,"connectInvalidCode"));return;}
  clearCode(c);
  if("on".equals(input.getFirst("trust")))remember(c,input.getFirst("deviceName"));
  c.success("email".equals(note(c,"mode"))?"eulab-email-otp":"otp");
 }
 public boolean requiresUser(){return true;}
 public boolean configuredFor(KeycloakSession session,RealmModel realm,UserModel user){return true;}
 public void setRequiredActions(KeycloakSession session,RealmModel realm,UserModel user){}
 public void close(){}
}
