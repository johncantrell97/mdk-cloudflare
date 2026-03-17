use lightning::util::config::UserConfig;

/// Create UserConfig with MDK defaults for JIT channel receiving.
/// Matches ldk-node's default_user_config() where applicable.
pub fn create_user_config() -> UserConfig {
    let mut config = UserConfig::default();

    // Allow LSP to open zero-reserve channels (client can withdraw full balance).
    // Setting to 0 means we don't require the counterparty to hold any reserve.
    config
        .channel_handshake_config
        .their_channel_reserve_proportional_millionths = 0;

    // Negotiate anchor channels — the modern standard. Without this, if the LSP
    // opens an anchor channel we'd reject it or force a legacy commitment format.
    config
        .channel_handshake_config
        .negotiate_anchors_zero_fee_htlc_tx = true;

    // Accept intercepted HTLCs for JIT channel flow
    config.accept_intercept_htlcs = true;

    // Manually accept inbound channels (for JIT channel opens from LSP)
    config.manually_accept_inbound_channels = true;

    // Accept HTLCs that pay less than the invoice amount — required for JIT channels
    // where the LSP deducts its fee from the forwarded HTLC amount.
    config.channel_config.accept_underpaying_htlcs = true;

    // Don't reject splice attempts from the LSP (ldk-node default)
    config.reject_inbound_splices = false;

    // Don't force channels to match our announcement preference (ldk-node default).
    // We're a private ephemeral node — we accept whatever the LSP offers.
    config
        .channel_handshake_limits
        .force_announced_channel_preference = false;

    config
}
