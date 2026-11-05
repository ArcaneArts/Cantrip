#!/usr/bin/python3
"""Disposable matched X11 workload. JSON stdin drives phases; no network listener."""
import ctypes as C
import json
import select
import sys
import time

x = C.CDLL('libX11.so.6')
x.XOpenDisplay.restype = C.c_void_p
x.XDefaultRootWindow.argtypes = [C.c_void_p]; x.XDefaultRootWindow.restype = C.c_ulong
x.XCreateSimpleWindow.argtypes = [C.c_void_p,C.c_ulong,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_uint,C.c_ulong,C.c_ulong]; x.XCreateSimpleWindow.restype = C.c_ulong
x.XCreateGC.argtypes = [C.c_void_p,C.c_ulong,C.c_ulong,C.c_void_p]; x.XCreateGC.restype = C.c_void_p
class Attributes(C.Structure):
    _fields_ = [('background_pixmap',C.c_ulong),('background_pixel',C.c_ulong),('border_pixmap',C.c_ulong),('border_pixel',C.c_ulong),('bit_gravity',C.c_int),('win_gravity',C.c_int),('backing_store',C.c_int),('backing_planes',C.c_ulong),('backing_pixel',C.c_ulong),('save_under',C.c_int),('event_mask',C.c_long),('do_not_propagate_mask',C.c_long),('override_redirect',C.c_int),('colormap',C.c_ulong),('cursor',C.c_ulong)]
for name,types in {
 'XChangeWindowAttributes':[C.c_void_p,C.c_ulong,C.c_ulong,C.c_void_p],
 'XMapRaised':[C.c_void_p,C.c_ulong], 'XSetInputFocus':[C.c_void_p,C.c_ulong,C.c_int,C.c_ulong],
 'XSelectInput':[C.c_void_p,C.c_ulong,C.c_long], 'XSetForeground':[C.c_void_p,C.c_void_p,C.c_ulong],
 'XFillRectangle':[C.c_void_p,C.c_ulong,C.c_void_p,C.c_int,C.c_int,C.c_uint,C.c_uint],
 'XDrawString':[C.c_void_p,C.c_ulong,C.c_void_p,C.c_int,C.c_int,C.c_char_p,C.c_int],
 'XPending':[C.c_void_p], 'XNextEvent':[C.c_void_p,C.c_void_p], 'XSync':[C.c_void_p,C.c_int],
}.items(): getattr(x,name).argtypes=types

d=x.XOpenDisplay(None)
if not d: raise RuntimeError('The actual X display could not be opened')
w=x.XCreateSimpleWindow(d,x.XDefaultRootWindow(d),0,0,1440,900,0,0,0)
a=Attributes();a.override_redirect=1
x.XChangeWindowAttributes(d,w,1<<9,C.byref(a));x.XSelectInput(d,w,1|(1<<15))
x.XMapRaised(d,w);x.XSetInputFocus(d,w,1,0);gc=x.XCreateGC(d,w,0,None)
phase='static';sequence=0;tick=0;running=True

def paint():
    x.XSetForeground(d,gc,0);x.XFillRectangle(d,w,gc,0,0,1440,900)
    x.XSetForeground(d,gc,0xffffff if sequence%2 else 0)
    x.XFillRectangle(d,w,gc,64,64,128,128)
    for line in range(40):
        color=0xaaaaaa if line%2 else 0xeeeeee
        x.XSetForeground(d,gc,color)
        text=('CantripOS matched stream workload | line %02d | files, terminal and editor text' % line).encode()
        y=30+line*21-(tick%21 if phase=='motion' else 0)
        x.XDrawString(d,w,gc,300,y,text,len(text))
    if phase=='motion':
        x.XSetForeground(d,gc,0xffffff)
        x.XFillRectangle(d,w,gc,300+(tick*13)%1000,850,100,35)
    x.XSync(d,False)
paint();print(json.dumps({'ready':True,'width':1440,'height':900}),flush=True)
last=time.monotonic()
while running:
    readable,_,_=select.select([sys.stdin],[],[],.003)
    if readable:
        raw=sys.stdin.readline()
        if not raw:break
        message=json.loads(raw)
        if message.get('stop'):break
        phase=message.get('phase',phase)
        sequence=message.get('sequence',sequence)
        paint();print(json.dumps({'ack':message.get('id'),'sequence':sequence,'phase':phase}),flush=True)
    while x.XPending(d):
        event=(C.c_long*24)();x.XNextEvent(d,C.byref(event))
        kind=C.cast(C.byref(event),C.POINTER(C.c_int))[0]
        if kind==2:
            sequence+=1;paint();print(json.dumps({'key':True,'sequence':sequence}),flush=True)
    now=time.monotonic()
    if phase=='motion' and now-last>=1/30:
        last=now;tick+=1;paint()
