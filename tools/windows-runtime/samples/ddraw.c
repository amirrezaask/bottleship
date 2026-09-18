/* SPDX-License-Identifier: MIT -- Original DirectDraw 7 collectible-square game. */
#define DIRECTDRAW_VERSION 0x0700
#include "common.h"
#include <ddraw.h>
static IDirectDraw7 *draw;
static IDirectDrawSurface7 *primary,*back;
static IDirectDrawClipper *clipper;
static void rectangle(int x,int y,int w,int h,DWORD color){RECT rect={x,y,x+w,y+h};DDBLTFX fx;memset(&fx,0,sizeof(fx));fx.dwSize=sizeof(fx);fx.dwFillColor=color;checked(IDirectDrawSurface7_Blt(back,&rect,0,0,DDBLT_COLORFILL|DDBLT_WAIT,&fx),"DirectDraw color fill");}
void start(void){
    DDSURFACEDESC2 desc;unsigned i;initialize("GameBox DirectDraw 7 - arrow keys collect stars");
    checked(DirectDrawCreateEx(0,(void**)&draw,&IID_IDirectDraw7,0),"DirectDrawCreateEx");checked(IDirectDraw7_SetCooperativeLevel(draw,window_handle,DDSCL_NORMAL),"SetCooperativeLevel");
    memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.dwFlags=DDSD_CAPS;desc.ddsCaps.dwCaps=DDSCAPS_PRIMARYSURFACE;
    checked(IDirectDraw7_CreateSurface(draw,&desc,&primary,0),"Create primary surface");
    checked(IDirectDraw7_CreateClipper(draw,0,&clipper,0),"CreateClipper");checked(IDirectDrawClipper_SetHWnd(clipper,0,window_handle),"SetHWnd clipper");checked(IDirectDrawSurface7_SetClipper(primary,clipper),"SetClipper");
    memset(&desc,0,sizeof(desc));desc.dwSize=sizeof(desc);desc.dwFlags=DDSD_CAPS|DDSD_WIDTH|DDSD_HEIGHT|DDSD_PIXELFORMAT;desc.dwWidth=WIDTH;desc.dwHeight=HEIGHT;desc.ddsCaps.dwCaps=DDSCAPS_OFFSCREENPLAIN|DDSCAPS_SYSTEMMEMORY;
    desc.ddpfPixelFormat.dwSize=sizeof(DDPIXELFORMAT);desc.ddpfPixelFormat.dwFlags=DDPF_RGB;desc.ddpfPixelFormat.dwRGBBitCount=32;desc.ddpfPixelFormat.dwRBitMask=0xff0000;desc.ddpfPixelFormat.dwGBitMask=0xff00;desc.ddpfPixelFormat.dwBBitMask=0xff;
    checked(IDirectDraw7_CreateSurface(draw,&desc,&back,0),"Create 32-bit back surface");
    while(running){LARGE_INTEGER begin;POINT origin={0,0};RECT destination;QueryPerformanceCounter(&begin);update_game();if(!running)break;
        rectangle(0,0,WIDTH,HEIGHT,0x102030);for(i=0;i<64;i++)if(stars_x[i]>=0)rectangle(stars_x[i],stars_y[i],8,8,0xffcc33);rectangle(player_x,player_y,12,12,0x44ddff);
        if(!ClientToScreen(window_handle,&origin))fail("ClientToScreen");destination.left=origin.x;destination.top=origin.y;destination.right=origin.x+WIDTH;destination.bottom=origin.y+HEIGHT;
        checked(IDirectDrawSurface7_Blt(primary,&destination,back,0,DDBLT_WAIT,0),"DirectDraw present blit");finish_frame(begin,"ddraw7");
    }
    IDirectDrawSurface7_Release(back);IDirectDrawSurface7_Release(primary);IDirectDrawClipper_Release(clipper);IDirectDraw7_Release(draw);shutdown_audio();DestroyWindow(window_handle);ExitProcess(0);
}
