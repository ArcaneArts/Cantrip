#[test]
fn reflow_preserves_soft_wraps_and_hard_newlines_through_scrollback() {
    let mut terminal = vt100::Parser::new(3, 8, 16);
    terminal.process(b"abcdefghijk\r\nsecond\r\n");
    terminal.screen_mut().set_size(3, 4);
    assert_eq!(terminal.screen().contents(), "second");
    assert_eq!(terminal.screen().cursor_position(), (2, 0));
    terminal.screen_mut().set_scrollback(16);
    assert_eq!(terminal.screen().scrollback(), 3);
    assert_eq!(terminal.screen().contents(), "abcdefghijk");
    assert!(terminal.screen().row_wrapped(0));
    assert!(terminal.screen().row_wrapped(1));
    assert!(!terminal.screen().row_wrapped(2));

    terminal.screen_mut().set_size(3, 8);
    assert_eq!(terminal.screen().contents(), "ijk\nsecond");
    terminal.screen_mut().set_scrollback(16);
    assert_eq!(terminal.screen().scrollback(), 1);
    assert_eq!(terminal.screen().contents(), "abcdefghijk\nsecond");
}

#[test]
fn growing_a_bottom_anchored_view_recovers_scrollback() {
    let mut terminal = vt100::Parser::new(2, 8, 2);
    terminal.process(b"first\r\nsecond\r\nthird");
    terminal.screen_mut().set_size(3, 8);
    assert_eq!(terminal.screen().contents(), "first\nsecond\nthird");
    assert_eq!(terminal.screen().cursor_position(), (2, 5));

    terminal.screen_mut().set_size(1, 8);
    assert_eq!(terminal.screen().contents(), "third");
    terminal.process(b"!!xY");
    assert_eq!(terminal.screen().contents(), "Y");
    terminal.screen_mut().set_scrollback(1);
    assert_eq!(terminal.screen().contents(), "third!!x");
    assert!(terminal.screen().row_wrapped(0));
}
