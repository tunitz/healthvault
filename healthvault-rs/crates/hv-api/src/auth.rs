//! Single-user auth policy ported from `src/lib/auth.ts`: scrypt password hashes, HMAC session
//! cookies, bearer tokens and host/origin checks. Secrets never enter argv or logs.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub const SESSION_COOKIE: &str = "hv_session";
pub const SESSION_DAYS: i64 = 30;
pub const LOGIN_WINDOW_MS: u64 = 15 * 60 * 1000;
pub const MAX_LOGIN_FAILURES: u32 = 5;
pub const SCRYPT_N: u32 = 16_384;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;
pub const SCRYPT_SALT_BYTES: usize = 16;
pub const SCRYPT_KEY_BYTES: usize = 32;

#[derive(Debug, Clone)]
pub struct AuthPolicy {
    password_hash: String,
    session_secret: String,
    agent_token: Option<String>,
    allowed_hosts: Vec<String>,
    cookie_secure: bool,
}

impl AuthPolicy {
    /// Fail closed at boot: a missing password hash or session secret is a startup error.
    pub fn from_env() -> Result<Self, String> {
        let password_hash = std::env::var("HEALTHVAULT_PASSWORD_HASH")
            .map_err(|_| "HEALTHVAULT_PASSWORD_HASH is required".to_owned())?;
        let session_secret = std::env::var("HEALTHVAULT_SESSION_SECRET")
            .map_err(|_| "HEALTHVAULT_SESSION_SECRET is required".to_owned())?;
        if session_secret.len() < 32 {
            return Err("HEALTHVAULT_SESSION_SECRET must be at least 32 characters".into());
        }
        let agent_token = std::env::var("HEALTHVAULT_TOKEN").ok().or_else(|| {
            std::env::var("HEALTHVAULT_TOKEN_FILE")
                .ok()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .map(|value| value.trim().to_owned())
        });
        let allowed_hosts = std::env::var("HEALTHVAULT_ALLOWED_HOSTS")
            .unwrap_or_else(|_| "localhost,127.0.0.1,::1".into())
            .split(',')
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect();
        let cookie_secure = std::env::var("HEALTHVAULT_COOKIE_SECURE")
            .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
        Ok(Self {
            password_hash,
            session_secret,
            agent_token,
            allowed_hosts,
            cookie_secure,
        })
    }

    /// Used by tests and local CLI tools; never reads secrets from argv.
    pub fn for_test(password: &str) -> Self {
        Self {
            password_hash: hash_password(password),
            session_secret: "test-session-secret-at-least-32-characters".into(),
            agent_token: Some("test-token".into()),
            allowed_hosts: vec!["localhost".into(), "127.0.0.1".into(), "::1".into()],
            cookie_secure: false,
        }
    }

    pub fn cookie_secure(&self) -> bool {
        self.cookie_secure
    }

    pub fn verify_password(&self, password: &str) -> bool {
        verify_password_hash(password, &self.password_hash)
    }

    pub fn sign_session(&self, now_ms: i64) -> String {
        let expires = now_ms.div_euclid(1000) + SESSION_DAYS * 86_400;
        format!(
            "v1.{expires}.{}",
            hex::encode(session_mac(&expires.to_string(), &self.session_secret))
        )
    }

    pub fn verify_session(&self, value: Option<&str>, now_ms: i64) -> bool {
        let Some(value) = value else { return false };
        let parts: Vec<&str> = value.split('.').collect();
        if parts.len() != 3
            || parts[0] != "v1"
            || !parts[1].bytes().all(|b| b.is_ascii_digit())
            || parts[2].len() != 64
        {
            return false;
        }
        let Ok(expires) = parts[1].parse::<i64>() else {
            return false;
        };
        if expires <= now_ms.div_euclid(1000) {
            return false;
        }
        let expected = session_mac(parts[1], &self.session_secret);
        let Ok(actual) = hex::decode(parts[2]) else {
            return false;
        };
        bool::from(actual.as_slice().ct_eq(expected.as_slice()))
    }

    pub fn verify_bearer(&self, header: Option<&str>) -> bool {
        let Some(expected) = &self.agent_token else {
            return false;
        };
        let Some(raw) = header else { return false };
        let Some(token) = raw
            .strip_prefix("Bearer ")
            .or_else(|| raw.strip_prefix("bearer "))
        else {
            return false;
        };
        if token.chars().any(char::is_whitespace) {
            return false;
        }
        bool::from(token.as_bytes().ct_eq(expected.as_bytes()))
    }

    /// Trusted host allowlist + same-origin check, matching `agentRequestFailure`.
    pub fn agent_request_failure(
        &self,
        host: Option<&str>,
        origin: Option<&str>,
        forwarded_proto: Option<&str>,
        request_scheme: &str,
        cookie: Option<&str>,
        bearer: Option<&str>,
        now_ms: i64,
    ) -> Option<(u16, &'static str)> {
        let Some(host) = host else {
            return Some((403, "untrusted host"));
        };
        let hostname = host
            .split(':')
            .next()
            .unwrap_or(host)
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        if !self
            .allowed_hosts
            .iter()
            .any(|allowed| host_allowed(allowed, &hostname))
        {
            return Some((403, "untrusted host"));
        }
        if let Some(origin) = origin {
            let scheme = match forwarded_proto {
                Some("http") => "http",
                Some("https") => "https",
                _ => request_scheme,
            };
            if origin.trim_end_matches('/') != format!("{scheme}://{host}") {
                return Some((403, "cross-origin request rejected"));
            }
        }
        let session = cookie.and_then(|raw| cookie_value(raw, SESSION_COOKIE));
        if self.verify_session(session, now_ms) || self.verify_bearer(bearer) {
            None
        } else {
            Some((401, "authentication required"))
        }
    }
}

/// Exact hostnames plus IPv4 CIDR ranges (e.g. `192.168.31.0/24`) are accepted. A malformed
/// range matches nothing: fail closed rather than widening an admin-specified policy.
fn host_allowed(allowed: &str, hostname: &str) -> bool {
    let allowed = allowed.trim_matches(|c| c == '[' || c == ']');
    if let Some((network, bits)) = allowed.split_once('/') {
        let Ok(bits) = bits.parse::<u32>() else {
            return false;
        };
        if bits > 32 {
            return false;
        }
        let (Some(network), Some(host)) = (ipv4(network), ipv4(hostname)) else {
            return false;
        };
        let mask = if bits == 0 {
            0
        } else {
            u32::MAX << (32 - bits)
        };
        return network & mask == host & mask;
    }
    allowed == hostname
}

fn ipv4(value: &str) -> Option<u32> {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut address = 0u32;
    for part in parts {
        let octet = part.parse::<u8>().ok()?;
        address = (address << 8) | u32::from(octet);
    }
    Some(address)
}

fn cookie_value<'a>(raw: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    raw.split(';')
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix(&prefix))
}

fn session_mac(expires: &str, secret: &str) -> [u8; 32] {
    match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mut mac) => {
            mac.update(expires.as_bytes());
            mac.finalize().into_bytes().into()
        }
        // HMAC accepts arbitrary key lengths; a failure here is a broken primitive, so fail closed.
        Err(_) => [0u8; 32],
    }
}

/// Random salt from the OS CSPRNG. The fallback exists only for platforms without /dev/urandom.
fn random_salt() -> [u8; SCRYPT_SALT_BYTES] {
    let mut salt = [0u8; SCRYPT_SALT_BYTES];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut salt))
        .is_ok()
    {
        return salt;
    }
    let mut state = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(1, |d| d.as_nanos() as u64);
    for byte in &mut salt {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *byte = (state >> 24) as u8;
    }
    salt
}

pub fn hash_password(password: &str) -> String {
    let salt = random_salt();
    let params = scrypt::Params::new(14, SCRYPT_R, SCRYPT_P).unwrap_or(scrypt::Params::RECOMMENDED);
    let mut derived = [0u8; SCRYPT_KEY_BYTES];
    if scrypt::scrypt(password.as_bytes(), &salt, &params, &mut derived).is_err() {
        return String::new();
    }
    format!(
        "scrypt:{}:{}:{}:{}:{}",
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        hex::encode(salt),
        hex::encode(derived)
    )
}

pub fn verify_password_hash(password: &str, raw: &str) -> bool {
    let Some(parts) = raw
        .strip_prefix("scrypt:")
        .and_then(|rest| rest.split(':').collect::<Vec<_>>().try_into().ok())
    else {
        return false;
    };
    let [n, r, p, salt_hex, hash_hex]: [&str; 5] = parts;
    let (Ok(n), Ok(r), Ok(p)) = (n.parse::<u32>(), r.parse::<u32>(), p.parse::<u32>()) else {
        return false;
    };
    let (Ok(salt), Ok(expected)) = (hex::decode(salt_hex), hex::decode(hash_hex)) else {
        return false;
    };
    let params = scrypt::Params::new(u8::try_from(n.trailing_zeros()).unwrap_or(0), r, p)
        .unwrap_or(scrypt::Params::RECOMMENDED);
    let mut derived = vec![0u8; expected.len()];
    if scrypt::scrypt(password.as_bytes(), &salt, &params, &mut derived).is_err() {
        return false;
    }
    bool::from(derived.ct_eq(&expected))
}

#[derive(Debug)]
pub struct LoginThrottle {
    failures: AtomicU64,
    reset_at: AtomicU64,
}

impl Default for LoginThrottle {
    fn default() -> Self {
        Self::new()
    }
}

impl LoginThrottle {
    pub fn new() -> Self {
        Self {
            failures: AtomicU64::new(0),
            reset_at: AtomicU64::new(0),
        }
    }

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }

    pub fn throttled(&self) -> bool {
        self.reset(Self::now());
        self.failures.load(Ordering::Acquire) >= u64::from(MAX_LOGIN_FAILURES)
    }

    fn reset(&self, now: u64) {
        if now >= self.reset_at.load(Ordering::Acquire) {
            self.failures.store(0, Ordering::Release);
            self.reset_at
                .store(now + LOGIN_WINDOW_MS, Ordering::Release);
        }
    }

    pub fn record_failure(&self) {
        let now = Self::now();
        self.reset(now);
        self.failures.fetch_add(1, Ordering::AcqRel);
    }

    pub fn clear(&self) {
        self.failures.store(0, Ordering::Release);
        self.reset_at.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_uses_the_canonical_six_part_format() {
        let hash = hash_password("correct horse battery staple");
        let parts: Vec<&str> = hash.split(':').collect();
        assert_eq!(parts.len(), 6);
        assert_eq!(parts[0], "scrypt");
        assert!(verify_password_hash("correct horse battery staple", &hash));
        assert!(!verify_password_hash("wrong", &hash));
    }

    #[test]
    fn session_tokens_expire_and_reject_tampering() {
        let policy = AuthPolicy::for_test("pw");
        let token = policy.sign_session(1_000_000);
        assert!(policy.verify_session(Some(&token), 1_000_000));
        assert!(!policy.verify_session(Some(&token), 1_000_000 + SESSION_DAYS * 86_400 * 1000));
        assert!(!policy.verify_session(Some(&format!("{token}x")), 1_000_000));
    }

    #[test]
    fn agent_bearer_uses_constant_time_comparison() {
        let policy = AuthPolicy::for_test("pw");
        assert!(policy.verify_bearer(Some("Bearer test-token")));
        assert!(!policy.verify_bearer(Some("Bearer test-token2")));
        assert!(!policy.verify_bearer(None));
    }

    #[test]
    fn host_origin_and_session_are_all_checked() {
        let policy = AuthPolicy::for_test("pw");
        let token = policy.sign_session(1_000_000);
        let cookie = format!("hv_session={token}; other=1");
        assert!(
            policy
                .agent_request_failure(
                    Some("127.0.0.1:3040"),
                    None,
                    None,
                    "http",
                    Some(&cookie),
                    None,
                    1_000_000
                )
                .is_none()
        );
        assert_eq!(
            policy.agent_request_failure(
                Some("evil.example"),
                None,
                None,
                "http",
                Some(&cookie),
                None,
                1_000_000
            ),
            Some((403, "untrusted host"))
        );
        assert_eq!(
            policy.agent_request_failure(
                Some("127.0.0.1:3040"),
                Some("http://evil.example"),
                None,
                "http",
                Some(&cookie),
                None,
                1_000_000
            ),
            Some((403, "cross-origin request rejected"))
        );
        assert_eq!(
            policy.agent_request_failure(
                Some("127.0.0.1:3040"),
                None,
                None,
                "http",
                None,
                None,
                1_000_000
            ),
            Some((401, "authentication required"))
        );
    }

    #[test]
    fn cidr_allowlist_admits_the_subnet_and_refuses_others() {
        let mut policy = AuthPolicy::for_test("pw");
        policy.allowed_hosts = vec!["192.168.31.0/24".into(), "localhost".into()];
        let token = policy.sign_session(1_000_000);
        let cookie = format!("hv_session={token}");
        assert!(
            policy
                .agent_request_failure(
                    Some("192.168.31.55:3041"),
                    None,
                    None,
                    "http",
                    Some(&cookie),
                    None,
                    1_000_000
                )
                .is_none()
        );
        assert!(
            policy
                .agent_request_failure(
                    Some("192.168.31.1:3041"),
                    None,
                    None,
                    "http",
                    Some(&cookie),
                    None,
                    1_000_000
                )
                .is_none()
        );
        assert_eq!(
            policy.agent_request_failure(
                Some("192.168.32.5:3041"),
                None,
                None,
                "http",
                Some(&cookie),
                None,
                1_000_000
            ),
            Some((403, "untrusted host"))
        );
        assert_eq!(
            policy.agent_request_failure(
                Some("not-an-ip:3041"),
                None,
                None,
                "http",
                Some(&cookie),
                None,
                1_000_000
            ),
            Some((403, "untrusted host"))
        );
    }
}
