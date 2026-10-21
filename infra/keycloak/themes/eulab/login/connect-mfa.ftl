<#import "template.ftl" as layout>
<@layout.registrationLayout; section>
 <#if section == "header">${msg("connectMfaTitle")}
 <#elseif section == "form">
 <form id="kc-connect-mfa" action="${url.loginAction}" method="post">
  <#if emailMode><p>${msg("connectEmailMode")}</p><#else><p>${msg("connectAppMode")}</p></#if>
  <div class="${properties.kcFormGroupClass!}">
   <label for="otp">${msg("connectCode")}</label>
   <input id="otp" name="otp" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus class="${properties.kcInputClass!}" />
  </div>
  <#if trustAvailable><div class="${properties.kcFormGroupClass!}"><label><input name="trust" type="checkbox"/> ${msg("connectTrust")}</label><label for="deviceName">${msg("connectDeviceName")}</label><input id="deviceName" name="deviceName" maxlength="80" class="${properties.kcInputClass!}"/></div></#if>
  <button class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!}" name="action" value="verify" type="submit">${msg("doSubmit")}</button>
  <#if emailAvailable><p>${msg("connectEmailHelp")}</p><button name="action" value="send-email" type="submit" formnovalidate>${msg("connectSendEmail")}</button></#if>
  <#if totpAvailable && emailMode><button name="action" value="use-totp" type="submit" formnovalidate>${msg("connectUseApp")}</button></#if>
  <button name="action" value="cancel" type="submit" formnovalidate>${msg("doCancel")}</button>
 </form>
 </#if>
</@layout.registrationLayout>
