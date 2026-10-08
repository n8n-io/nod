set -eu

curl -fsSL https://github.com/rtk-ai/rtk/archive/e001f773f80b22b7dc4c7a79521b30e35aaef026.tar.gz -o /tmp/rtk.tar.gz
printf '%s\n' 'cb8dfde05bfe102c06400d121faa6399a5d590a3f3ba95eae8c53b7e5dab1873  /tmp/rtk.tar.gz' | sha256sum -c -
mkdir /tmp/rtk
tar -xzf /tmp/rtk.tar.gz -C /tmp/rtk --strip-components=1
if [ "${1:-}" = prebuilt ]; then
    test "$(uname -m)" = x86_64
    curl -fsSL https://github.com/rtk-ai/rtk/releases/download/v0.51.0/rtk-x86_64-unknown-linux-musl.tar.gz -o /tmp/rtk-binary.tar.gz
    printf '%s\n' '5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5  /tmp/rtk-binary.tar.gz' | sha256sum -c -
    mkdir -p /opt/rtk/bin
    tar -xzf /tmp/rtk-binary.tar.gz -C /opt/rtk/bin rtk
    rm /tmp/rtk-binary.tar.gz
else
    RTK_TELEMETRY_URL= RTK_TELEMETRY_TOKEN= cargo install --path /tmp/rtk --locked --root /opt/rtk
fi
test "$(/opt/rtk/bin/rtk --version)" = 'rtk 0.51.0'
install -m 444 /tmp/rtk/LICENSE /opt/rtk/LICENSE
rm -rf /tmp/rtk /tmp/rtk.tar.gz
