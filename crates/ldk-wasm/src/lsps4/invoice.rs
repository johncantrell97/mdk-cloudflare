//! Create BOLT11 invoices with LSP route hints for JIT channels.
//!
//! When an ephemeral node needs to receive a payment but has no channels yet,
//! it creates an invoice with a route hint pointing through the LSP's intercept
//! SCID. When a sender pays the invoice, the HTLC arrives at the LSP, which
//! opens a JIT channel to deliver the payment.

use core::time::Duration;
use std::sync::Arc;

use bitcoin::hashes::{sha256, Hash};
use bitcoin::secp256k1::PublicKey;
use lightning::sign::{KeysManager, NodeSigner, Recipient};
use lightning_invoice::{
    Bolt11Invoice, Currency, InvoiceBuilder, RouteHint, RouteHintHop, RoutingFees,
};

use crate::types::ChannelManager;

/// Create a BOLT11 invoice with an LSP route hint for JIT channel opening.
///
/// The invoice includes a private route hint through the LSP using the
/// intercept SCID from the LSPS4 order. When a payment arrives at the LSP
/// for this SCID, it triggers JIT channel creation.
///
/// # Arguments
///
/// * `channel_manager` - The node's channel manager (for creating inbound payments)
/// * `keys_manager` - The node's keys manager (for signing the invoice)
/// * `lsp_pubkey` - The LSP's public key (route hint source node)
/// * `intercept_scid` - The SCID assigned by the LSP for HTLC interception
/// * `cltv_expiry_delta` - The CLTV delta for the route hint hop
/// * `amount_sats` - Invoice amount in satoshis, or `None` for variable-amount invoices
/// * `description` - Human-readable description for the invoice
/// * `expiry_secs` - Invoice validity duration in seconds
/// * `network` - The Bitcoin network (determines invoice prefix)
/// * `now_epoch_secs` - Current time as seconds since Unix epoch
pub fn create_jit_invoice(
    channel_manager: &ChannelManager,
    keys_manager: &Arc<KeysManager>,
    lsp_pubkey: PublicKey,
    intercept_scid: u64,
    cltv_expiry_delta: u16,
    amount_sats: Option<u64>,
    description: &str,
    expiry_secs: u32,
    network: Currency,
    now_epoch_secs: u64,
) -> Result<Bolt11Invoice, String> {
    let amount_msat = amount_sats.map(|s| s * 1000);

    // Step 1: Create inbound payment — generates payment_hash and secret
    // that the ChannelManager will recognize when the HTLC arrives.
    // When amount_msat is None, LDK will accept any amount for this payment_hash.
    let (payment_hash, payment_secret) = channel_manager
        .create_inbound_payment(amount_msat, expiry_secs, Some(cltv_expiry_delta))
        .map_err(|()| "Failed to create inbound payment".to_string())?;

    // Step 2: Build route hint through the LSP.
    // The intercept SCID is a fake channel ID that the LSP watches for.
    // When an HTLC arrives for this SCID, the LSP opens a JIT channel.
    let route_hint = RouteHint(vec![RouteHintHop {
        src_node_id: lsp_pubkey,
        short_channel_id: intercept_scid,
        fees: RoutingFees {
            base_msat: 0,
            proportional_millionths: 0,
        },
        cltv_expiry_delta,
        htlc_minimum_msat: None,
        htlc_maximum_msat: None,
    }]);

    // Step 3: Build the raw invoice.
    // We use duration_since_epoch instead of current_timestamp because
    // the lightning-invoice crate is compiled without the `std` feature
    // (required for WASM compatibility).
    // InvoiceBuilder is a typed state machine — .amount_milli_satoshis()
    // must be omitted entirely for variable-amount invoices (not called with 0).
    let builder = InvoiceBuilder::new(network)
        .description(description.to_string())
        .duration_since_epoch(Duration::from_secs(now_epoch_secs))
        .payment_hash(sha256::Hash::from_slice(&payment_hash.0).expect("32-byte hash"))
        .payment_secret(payment_secret)
        .min_final_cltv_expiry_delta(cltv_expiry_delta as u64)
        .expiry_time(Duration::from_secs(expiry_secs as u64))
        .private_route(route_hint);

    let raw_invoice = if let Some(msat) = amount_msat {
        builder.amount_milli_satoshis(msat).build_raw()
    } else {
        builder.build_raw()
    }
    .map_err(|e| format!("Failed to build invoice: {:?}", e))?;

    // Step 4: Sign the invoice with the node's key.
    let signature = keys_manager
        .sign_invoice(&raw_invoice, Recipient::Node)
        .map_err(|()| "Failed to sign invoice".to_string())?;

    let signed = raw_invoice
        .sign::<_, ()>(|_| Ok(signature))
        .expect("sign closure is infallible");

    let invoice =
        Bolt11Invoice::from_signed(signed).map_err(|e| format!("Invalid invoice: {:?}", e))?;

    Ok(invoice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::ldk_helpers::{test_channel_manager, test_lsp_pubkey};
    use bitcoin::Network;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn test_create_jit_invoice_fixed_amount() {
        let (cm, km) = test_channel_manager(Network::Signet);
        let lsp = test_lsp_pubkey();
        let intercept_scid = (800u64 << 40) | (3u64 << 16);

        let invoice = create_jit_invoice(
            &cm,
            &km,
            lsp,
            intercept_scid,
            80,
            Some(1000),
            "test payment",
            3600,
            Currency::Signet,
            1_704_067_200,
        )
        .unwrap();

        // 1000 sats = 1_000_000 msats
        assert_eq!(invoice.amount_milli_satoshis(), Some(1_000_000));

        // Route hint should contain LSP pubkey and intercept SCID
        let route_hints = invoice.route_hints();
        assert_eq!(route_hints.len(), 1);
        let hop = &route_hints[0].0[0];
        assert_eq!(hop.src_node_id, lsp);
        assert_eq!(hop.short_channel_id, intercept_scid);
    }

    #[wasm_bindgen_test]
    fn test_create_jit_invoice_variable_amount() {
        let (cm, km) = test_channel_manager(Network::Signet);

        let invoice = create_jit_invoice(
            &cm,
            &km,
            test_lsp_pubkey(),
            12345,
            80,
            None,
            "variable amount",
            3600,
            Currency::Signet,
            1_704_067_200,
        )
        .unwrap();

        assert_eq!(invoice.amount_milli_satoshis(), None);
    }

    #[wasm_bindgen_test]
    fn test_create_jit_invoice_expiry() {
        let (cm, km) = test_channel_manager(Network::Signet);
        let expiry_secs = 7200u32;

        let invoice = create_jit_invoice(
            &cm,
            &km,
            test_lsp_pubkey(),
            12345,
            80,
            Some(500),
            "expiry test",
            expiry_secs,
            Currency::Signet,
            1_704_067_200,
        )
        .unwrap();

        assert_eq!(
            invoice.expiry_time(),
            core::time::Duration::from_secs(expiry_secs as u64)
        );
    }

    #[wasm_bindgen_test]
    fn test_create_jit_invoice_is_signed() {
        let (cm, km) = test_channel_manager(Network::Signet);

        let invoice = create_jit_invoice(
            &cm,
            &km,
            test_lsp_pubkey(),
            12345,
            80,
            Some(1000),
            "signed test",
            3600,
            Currency::Signet,
            1_704_067_200,
        )
        .unwrap();

        // Convert to string and parse back
        let invoice_str = invoice.to_string();
        let parsed: Bolt11Invoice = invoice_str.parse().unwrap();

        // Same payment hash
        assert_eq!(parsed.payment_hash(), invoice.payment_hash());
    }
}
