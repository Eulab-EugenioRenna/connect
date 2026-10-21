package cloud.eulab.connect;
import java.util.HashSet;
public class SecurityTokensTest {
 public static void main(String[] args){
  var tokens=new HashSet<String>();for(int i=0;i<10000;i++){String token=SecurityTokens.token();if(token.length()!=43||!tokens.add(token))throw new AssertionError("Token entropy/encoding");if(!SecurityTokens.code().matches("[0-9]{6}"))throw new AssertionError("OTP format");}
  String salt=SecurityTokens.token(),hash=SecurityTokens.digest(salt+"000123");
  if(!SecurityTokens.validCode("000123",salt,hash,2000,0,1000))throw new AssertionError("Valid OTP rejected");
  for(String code:new String[]{"123","000124","000123 ","１２３４５６"})if(SecurityTokens.validCode(code,salt,hash,2000,0,1000))throw new AssertionError("Invalid OTP accepted");
  if(SecurityTokens.validCode("000123",salt,hash,1000,0,1000)||SecurityTokens.validCode("000123",salt,hash,2000,5,1000)||SecurityTokens.validCode("000123",null,hash,2000,0,1000)||SecurityTokens.matches(null,hash))throw new AssertionError("Expired/exhausted OTP accepted");
  System.out.println("OTP format, expiry, attempt cap, constant-time comparison and 10000 random tokens: OK");
 }
}
