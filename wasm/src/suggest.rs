//! VRF seed generator for follow suggestions.
//!
//! Returns cryptographically provable random bytes that the frontend uses
//! to seed a deterministic PageRank ranking algorithm. The VRF proves the
//! randomness was unmanipulated; the ranking algorithm is public code,
//! so anyone can replay it with the same seed against the same FastData
//! to verify the results independently.

use crate::types::{err_coded, ok_response, Response};
use outlayer::vrf;

// RESPONSE: { output_hex, signature_hex, alpha, vrf_public_key }
pub fn handle_get_vrf_seed() -> Response {
    let result = match vrf::random("suggest") {
        Ok(r) => r,
        Err(e) => return err_coded("VRF_ERROR", &format!("VRF failed: {e}")),
    };

    let pubkey = vrf::public_key().unwrap_or_default();

    ok_response(serde_json::json!({
        "output_hex": result.output_hex,
        "signature_hex": result.signature_hex,
        "alpha": result.alpha,
        "vrf_public_key": pubkey,
    }))
}
