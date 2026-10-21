package cloud.eulab.connect;
import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.*;
import org.keycloak.provider.ProviderConfigProperty;
public final class ConnectMfaFactory implements AuthenticatorFactory {
 public Authenticator create(KeycloakSession session){return new ConnectMfa();}
 public String getId(){return "eulab-connect-mfa";}
 public String getDisplayType(){return "EULab · app OTP, email e dispositivo attendibile";}
 public String getHelpText(){return "Secondo fattore dopo la password. Email verificata o app OTP; fiducia esplicita per 30 giorni su HTTPS.";}
 public String getReferenceCategory(){return "eulab-mfa";}
 public boolean isConfigurable(){return false;}
 public boolean isUserSetupAllowed(){return false;}
 public AuthenticationExecutionModel.Requirement[] getRequirementChoices(){return new AuthenticationExecutionModel.Requirement[]{AuthenticationExecutionModel.Requirement.REQUIRED,AuthenticationExecutionModel.Requirement.DISABLED};}
 public List<ProviderConfigProperty> getConfigProperties(){return List.of();}
 public void init(Config.Scope config){}
 public void postInit(KeycloakSessionFactory factory){}
 public void close(){}
}
