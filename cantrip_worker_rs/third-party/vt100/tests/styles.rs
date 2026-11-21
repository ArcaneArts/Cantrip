#[test]
fn replay_preserves_independent_intensity_and_style_resets() {
    let mut source = vt100::Parser::new(2, 12, 0);
    source
        .process(b"\x1b[31;1;2;5;8;9;53mA\x1b[22;1;25;28;29;55mB\x1b[22;2mC");
    let original = source.screen();
    let first = original.cell(0, 0).unwrap();
    assert!(first.bold() && first.dim());

    let encoded = original.contents_formatted();
    let text = String::from_utf8_lossy(&encoded);
    assert!(text.contains("\x1b[31;1;2;5;8;9;53mA"));
    assert!(text.contains("\x1b[22;1;25;28;29;55mB"));
    assert!(text.contains("\x1b[22;2mC"));

    let mut restored = vt100::Parser::new(2, 12, 0);
    restored.process(&encoded);
    for col in 0..3 {
        assert_eq!(restored.screen().cell(0, col), original.cell(0, col));
    }
}

#[test]
fn link_underline_survives_sgr_reset_and_ends_with_the_link() {
    let mut source = vt100::Parser::new(2, 12, 0);
    source.process(b"\x1b]8;;https://example.invalid/a;b\x07A\x1b[0mB");
    source.process(b"\x1b[24mC\x1b[4m\x1b]8;;\x1b\\D\x1b[24mE");
    source.process(b"\x1b[21mF\x1b[4:0mG\x1b[4:3mH");
    let encoded = source.screen().contents_formatted();
    let mut restored = vt100::Parser::new(2, 12, 0);
    restored.process(&encoded);
    assert_eq!(restored.screen().contents(), "ABCDEFGH");
    let underlined = [true, true, true, true, false, true, false, true];
    for (col, underline) in underlined.into_iter().enumerate() {
        assert_eq!(
            restored
                .screen()
                .cell(0, col.try_into().unwrap())
                .unwrap()
                .underline(),
            underline
        );
    }
    assert!(!String::from_utf8_lossy(&encoded).contains("example.invalid"));
}

#[test]
fn foreground_and_background_colors_reset_independently() {
    let mut source = vt100::Parser::new(2, 12, 0);
    source.process(b"\x1b[38;2;0;0;0;48;5;240mA\x1b[39mB\x1b[49;31mC");
    let mut restored = vt100::Parser::new(2, 12, 0);
    restored.process(&source.screen().contents_formatted());

    let expected = [
        (vt100::Color::Rgb(0, 0, 0), vt100::Color::Idx(240)),
        (vt100::Color::Default, vt100::Color::Idx(240)),
        (vt100::Color::Idx(1), vt100::Color::Default),
    ];
    for (col, (foreground, background)) in (0..).zip(expected) {
        let cell = restored.screen().cell(0, col).unwrap();
        assert_eq!(cell.fgcolor(), foreground);
        assert_eq!(cell.bgcolor(), background);
    }
}
