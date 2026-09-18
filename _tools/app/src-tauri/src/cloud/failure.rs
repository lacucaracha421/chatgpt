//! Durable, non-secret reasons for cloud background failures.
//!
//! The forensic trace of the locked-keyring sample (2026-09-18 22:44 KST) could only
//! reconstruct its cause from timestamps, because every background failure was collapsed
//! into one generic connectivity message. A specific `CredentialStoreLocked` was
//! therefore indistinguishable, in the durable record, from a real network outage - which
//! is precisely the question that mattered when deciding what to fix.
//!
//! The human message is unchanged: it is what the UI shows, and it must stay stable. What
//! this adds is a machine-readable code beside it. The code is chosen from a closed set of
//! literals, never formatted from an error value, so no token, URL, filesystem path or
//! backend diagnostic can reach the database.

use crate::library::error::LibraryError;

/// Why a cloud background pass failed, as a stable code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudFailureReason {
    /// The OS credential store is present but locked (Linux Secret Service collection).
    /// Distinct from a network failure: the fix is to unlock the keyring, not the network.
    CredentialStoreLocked,
    /// The credential store could not be reached or refused the operation.
    CredentialStoreUnavailable,
    /// No credential is configured for the required target.
    CredentialNotConfigured,
    /// The OS does not provide a credential store this build can use.
    CredentialStoreFailed,
    /// The server definitively rejected the credential (401/403).
    Unauthorized,
    /// A transport-level failure: offline, DNS, connection refused, TLS.
    Network,
    /// A timed-out request. Retryable; says nothing about credential validity.
    Timeout,
    /// The server accepted the connection but rejected or failed the operation.
    Server,
}

impl CloudFailureReason {
    /// The stored code. A literal from a closed set.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::CredentialStoreLocked => "credential_store_locked",
            Self::CredentialStoreUnavailable => "credential_store_unavailable",
            Self::CredentialNotConfigured => "credential_not_configured",
            Self::CredentialStoreFailed => "credential_store_failed",
            Self::Unauthorized => "unauthorized",
            Self::Network => "network",
            Self::Timeout => "timeout",
            Self::Server => "server",
        }
    }

    /// Classify a failed cloud pass.
    ///
    /// The credential causes are checked first and named individually: they are the ones
    /// the previous code hid behind a connectivity message, and telling them apart from a
    /// genuine network fault is the entire point of this type.
    pub(crate) fn from_error(error: &LibraryError) -> Self {
        match error {
            LibraryError::CredentialStoreLocked => Self::CredentialStoreLocked,
            LibraryError::CredentialStoreUnavailable => Self::CredentialStoreUnavailable,
            LibraryError::CredentialStoreFailed => Self::CredentialStoreFailed,
            LibraryError::CloudCredentialNotConfigured
            | LibraryError::AladinCredentialNotConfigured => Self::CredentialNotConfigured,
            LibraryError::CloudUnauthorized => Self::Unauthorized,
            LibraryError::CloudRequestTimedOut => Self::Timeout,
            LibraryError::CloudRequestUnavailable => Self::Network,
            // Anything else reached a server that refused or failed the operation. Left as
            // the catch-all rather than enumerated, so a newly added server-side error
            // reads as `server` instead of silently claiming to be a network problem.
            _ => Self::Server,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_each_credential_cause_individually() {
        // These were the causes the generic message erased. Each must stay distinct, or
        // the next forensic trace is as blind as the last one.
        for (error, expected) in [
            (LibraryError::CredentialStoreLocked, "credential_store_locked"),
            (LibraryError::CredentialStoreUnavailable, "credential_store_unavailable"),
            (LibraryError::CredentialStoreFailed, "credential_store_failed"),
            (LibraryError::CloudCredentialNotConfigured, "credential_not_configured"),
        ] {
            assert_eq!(CloudFailureReason::from_error(&error).code(), expected);
        }
    }

    #[test]
    fn separates_credential_invalidity_from_transient_network_failure() {
        // A locked store and an unreachable server need different operator actions.
        assert_eq!(
            CloudFailureReason::from_error(&LibraryError::CredentialStoreLocked).code(),
            "credential_store_locked"
        );
        assert_eq!(
            CloudFailureReason::from_error(&LibraryError::CloudUnauthorized).code(),
            "unauthorized"
        );
        assert_eq!(
            CloudFailureReason::from_error(&LibraryError::CloudRequestUnavailable).code(),
            "network"
        );
        assert_eq!(
            CloudFailureReason::from_error(&LibraryError::CloudRequestTimedOut).code(),
            "timeout"
        );
        assert_eq!(
            CloudFailureReason::from_error(&LibraryError::CloudUploadRejected(503)).code(),
            "server"
        );
    }

    #[test]
    fn every_code_is_a_stable_non_secret_literal() {
        let reasons = [
            CloudFailureReason::CredentialStoreLocked,
            CloudFailureReason::CredentialStoreUnavailable,
            CloudFailureReason::CredentialNotConfigured,
            CloudFailureReason::CredentialStoreFailed,
            CloudFailureReason::Unauthorized,
            CloudFailureReason::Network,
            CloudFailureReason::Timeout,
            CloudFailureReason::Server,
        ];
        for reason in reasons {
            let code = reason.code();
            assert!(!code.is_empty());
            // Codes are lowercase snake case: no whitespace, no formatting, no error text.
            assert!(
                code.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{code}"
            );
        }
    }
}
