// Cantrip window-effect shader ABI v1. All lanes are exactly 16 bytes.
#include <metal_stdlib>
using namespace metal;
constant uint CANTRIP_EFFECT_VERSION = 1;
constant uint CANTRIP_MAX_CURSORS = 16;
constant uint CANTRIP_MAX_EVENTS = 64;
struct CantripCursor {
    uint4 identity;
    float4 position; // logical xy, normalized xy (top-left origin)
    float4 velocity; // raw xy, smoothed xy, logical points/second
    float4 color;
    uint4 state; // visible, held buttons, held modifiers, recent-event count
    uint4 sequence; // low/high words, reserved
    float4 clickTime; // press/release seconds, press/release ages; -1 age = never
};
struct CantripEvent {
    uint4 identity;
    uint4 event; // kind, code, modifier flags, has position
    uint4 sequence; // low/high words, reserved
    float4 position; // logical xy, normalized xy
    float4 timing; // time, age, scroll delta xy
};
struct CantripFrame {
    uint4 header; // version, cursor count, event count, frame counter
    float4 time; // render time, frame delta, source time, capture age (seconds)
    float4 window; // logical size xy, pixel scale xy
    float4 texture; // pixel size xy, reciprocal size xy
    float4 parameters[4]; // descriptor-order values, booleans 0 or 1
    CantripCursor cursors[16];
    CantripEvent events[64];
};
struct CantripVertex { float4 position [[position]]; float2 uv; };
// Fixed geometry only. All visual effect logic belongs in fragment functions.
vertex CantripVertex cantrip_surface(uint id [[vertex_id]]) {
    float2 uv = float2((id << 1) & 2, id & 2);
    return {float4(uv.x * 2 - 1, 1 - uv.y * 2, 0, 1), uv};
}
