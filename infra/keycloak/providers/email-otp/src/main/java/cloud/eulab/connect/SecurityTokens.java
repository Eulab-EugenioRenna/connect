package cloud.eulab.connect;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
public final class SecurityTokens {
 private static final SecureRandom RANDOM=new SecureRandom();
 private SecurityTokens() {}
 public static String code(){return String.format(java.util.Locale.ROOT,"%06d",RANDOM.nextInt(1_000_000));}
 public static String token(){byte[] b=new byte[32];RANDOM.nextBytes(b);return Base64.getUrlEncoder().withoutPadding().encodeToString(b);}
 public static String digest(String value){try{return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}catch(java.security.NoSuchAlgorithmException e){throw new IllegalStateException(e);}}
 public static boolean matches(String expected,String actual){return expected!=null&&actual!=null&&MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),actual.getBytes(StandardCharsets.UTF_8));}
 public static boolean validCode(String code,String salt,String digest,long expiresAt,int attempts,long now){return code!=null&&code.matches("[0-9]{6}")&&attempts<5&&expiresAt>now&&salt!=null&&matches(digest,digest(salt+code));}
}
