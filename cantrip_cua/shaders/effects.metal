// The runtime prepends contract.metal. This file contains fragment effects only.
static_assert(sizeof(CantripCursor) == 112, "Cantrip cursor ABI mismatch");
static_assert(sizeof(CantripEvent) == 80, "Cantrip event ABI mismatch");
static_assert(sizeof(CantripFrame) == 7040, "Cantrip frame ABI mismatch");
constexpr sampler windowSampler(coord::normalized, address::clamp_to_edge, filter::linear);
fragment float4 cantrip_passthrough(CantripVertex in [[stage_in]],
                                    texture2d<float> source [[texture(0)]]) {
    return source.sample(windowSampler, in.uv);
}
float segmentDistance(float2 p, float2 a, float2 b) {
    float2 v = b - a;
    return length(p - a - v * clamp(dot(p-a,v) / max(dot(v,v), 0.001f), 0.0f, 1.0f));
}
float rectangle(float2 p, float2 lo, float2 hi) {
    return all(p >= lo) && all(p <= hi) ? 1.0f : 0.0f;
}
fragment float4 cantrip_debug_gradient(CantripVertex in [[stage_in]],
    texture2d<float> source [[texture(0)]],
    texture2d<float> history [[texture(1)]],
    constant CantripFrame &frame [[buffer(0)]]) {
    float4 pixel = source.sample(windowSampler, in.uv);
    float3 clean = pixel.rgb / max(pixel.a, 0.0001f);
    float strength = frame.parameters[0].x;
    float3 color = mix(clean, 1.0f-clean, strength * (0.25f + 0.75f * in.uv.x));
    float2 p = in.uv * frame.window.xy;
    // Unmistakable effect-only FX badge and moving time stripe.
    if (rectangle(p, float2(12,12), float2(160,44))) {
        color = float3(0.08f,0.02f,0.16f);
        float2 q = p-float2(20,19);
        bool f = rectangle(q,float2(0,0),float2(3,18)) ||
                 rectangle(q,float2(0,0),float2(13,3)) ||
                 rectangle(q,float2(0,7),float2(10,10));
        bool x = segmentDistance(q,float2(20,0),float2(33,18)) < 1.7f ||
                 segmentDistance(q,float2(33,0),float2(20,18)) < 1.7f;
        if (f || x) color = float3(1,0.3f,0.9f);
        if (p.x > 66 && p.x < 150 && p.y > 26 && p.y < 32)
            color = mix(float3(0,0.9f,0.9f), float3(1,0.4f,0), fract((p.x-66)/84 + frame.time.x*0.4f));
    }
    if (frame.parameters[0].z > 0.5f) {
        float radius = frame.parameters[0].y;
        for (uint i = 0; i < min(frame.header.y, CANTRIP_MAX_CURSORS); ++i) {
            CantripCursor c = frame.cursors[i];
            if (!c.state.x) continue;
            float2 center = c.position.xy;
            float speed = length(c.velocity.zw);
            float2 direction = c.velocity.zw / max(speed, 1.0f);
            float line = segmentDistance(p, center, center + direction * min(speed*0.04f,radius));
            if (speed > 1 && line < 1.5f) color = c.color.rgb;
            float rawSpeed = length(c.velocity.xy);
            float rawLine = segmentDistance(p,center,center+c.velocity.xy/max(rawSpeed,1.0f)*min(rawSpeed*0.04f,radius));
            if (rawSpeed > 1 && rawLine < 0.6f) color = mix(color,float3(1),0.65f);
            float circle = abs(length(p-center) - radius * 0.2f);
            if (c.state.y && circle < 2) color = c.color.rgb;
            // Four short ticks make held event-local modifiers inspectable.
            for (uint bit=0; bit<4; ++bit)
                if ((c.state.z & (1u<<bit)) && rectangle(p-center,float2(-12.0f+float(bit)*7.0f,-22),float2(-8.0f+float(bit)*7.0f,-17)))
                    color = c.color.rgb;
        }
        for (uint i=0; i<min(frame.header.z,CANTRIP_MAX_EVENTS); ++i) {
            CantripEvent e = frame.events[i];
            if (!e.event.w || (e.event.x != 1 && e.event.x != 6) || e.timing.y > 0.6f) continue;
            float age = max(e.timing.y,0.0f);
            float ring = abs(length(p-e.position.xy) - (8.0f + age*radius));
            if (ring < 2) color = mix(color,float3(1,0.65f,0.1f),(1-age/0.6f)*0.8f);
        }
    }
    return float4(color * pixel.a, pixel.a);
}

// Local lens + velocity wake + expanding press ripples. Sample clean video only;
// the separately composited cursor is never part of this displacement field.
fragment float4 cantrip_cursor_warp(CantripVertex in [[stage_in]],
    texture2d<float> source [[texture(0)]],
    constant CantripFrame &frame [[buffer(0)]]) {
    float strength = frame.parameters[0].x;
    if (strength <= 0) return source.sample(windowSampler, in.uv);
    float radius = max(frame.parameters[0].y, 1.0f);
    float motion = frame.parameters[0].z;
    float ripple = frame.parameters[0].w;
    float2 size = max(frame.window.xy, float2(1));
    float2 p = in.uv * size;
    float2 displacement = float2(0);
    for (uint i=0; i<min(frame.header.y,CANTRIP_MAX_CURSORS); ++i) {
        CantripCursor c = frame.cursors[i];
        if (!c.state.x) continue;
        float2 delta = p-c.position.xy;
        float distance = length(delta);
        if (distance >= radius) continue;
        float falloff = 1.0f-smoothstep(0.0f,radius,distance);
        falloff *= falloff;
        float speed = length(c.velocity.zw);
        float response = 1.0f-exp(-speed/900.0f);
        float2 direction = c.velocity.zw/max(speed,1.0f);
        // Tiny resting lens, stronger while moving or holding a button.
        displacement += delta*falloff*(0.025f+0.10f*response*motion+(c.state.y ? 0.025f : 0.0f));
        displacement -= direction*(radius*0.12f*response*motion*falloff);
    }
    for (uint i=0; i<min(frame.header.z,CANTRIP_MAX_EVENTS); ++i) {
        CantripEvent e = frame.events[i];
        float age = e.timing.y * max(frame.parameters[1].x, 0.1f);
        if (!e.event.w || (e.event.x != 1 && e.event.x != 6) || age < 0 || age >= 0.65f) continue;
        float2 delta = p-e.position.xy;
        float distance = length(delta);
        if (distance >= radius*1.4f) continue;
        float travel = radius*(0.12f+1.8f*age);
        float band = (distance-travel)/max(radius*0.12f,1.0f);
        float envelope = exp(-band*band)*(1.0f-smoothstep(0.0f,0.65f,age));
        envelope *= 1.0f-smoothstep(radius,radius*1.4f,distance);
        displacement += delta/max(distance,1.0f)*sin(band*2.4f)*envelope*radius*0.045f*ripple;
    }
    // Bound overlapping agents/clicks and fade at the window boundary so the
    // filter cannot pull a long clamped edge smear across the application.
    displacement *= strength;
    displacement *= min(1.0f,radius*0.22f/max(length(displacement),0.001f));
    float edge = min(min(p.x,p.y),min(size.x-p.x,size.y-p.y));
    displacement *= smoothstep(0.0f,min(radius*0.25f,24.0f),edge);
    return source.sample(windowSampler,clamp((p+displacement)/size,float2(0),float2(1)));
}
