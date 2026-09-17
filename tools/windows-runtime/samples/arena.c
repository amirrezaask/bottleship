/* SPDX-License-Identifier: MIT -- Original collectible-square game for D3D8/9. */
#include "common.h"
#if SAMPLE_D3D == 8
#include <d3d8.h>
static IDirect3D8 *d3d;
static IDirect3DDevice8 *device;
#define CALL(name,...) IDirect3DDevice8_##name(device,__VA_ARGS__)
#define BEGIN() IDirect3DDevice8_BeginScene(device)
#define END() IDirect3DDevice8_EndScene(device)
#define API_NAME "d3d8"
#else
#include <d3d9.h>
static IDirect3D9 *d3d;
static IDirect3DDevice9 *device;
#define CALL(name,...) IDirect3DDevice9_##name(device,__VA_ARGS__)
#define BEGIN() IDirect3DDevice9_BeginScene(device)
#define END() IDirect3DDevice9_EndScene(device)
#define API_NAME "d3d9-d3dx9"
typedef struct { float x,y,z; } Vec;
typedef struct { float v[16]; } Matrix;
static Matrix *(WINAPI *matrix_translation)(Matrix*,float,float,float);
static Matrix *(WINAPI *matrix_multiply)(Matrix*,const Matrix*,const Matrix*);
static Vec *(WINAPI *transform_coord)(Vec*,const Vec*,const Matrix*);
static void check_d3dx(void){
    HMODULE dll=LoadLibraryA("d3dx9_43.dll");
    BOOL (WINAPI *check_version)(UINT,UINT);
    Matrix *(WINAPI *look_at)(Matrix*,const Vec*,const Vec*,const Vec*);
    Matrix camera;Vec eye={0,0,0},at={0,0,1},up={0,1,0};
    if(!dll)fail("D3DX9 DLL missing: this sample requires the legacy DirectX redist or Bottleship HLE");
    check_version=(void*)GetProcAddress(dll,"D3DXCheckVersion");look_at=(void*)GetProcAddress(dll,"D3DXMatrixLookAtLH");
    matrix_translation=(void*)GetProcAddress(dll,"D3DXMatrixTranslation");matrix_multiply=(void*)GetProcAddress(dll,"D3DXMatrixMultiply");transform_coord=(void*)GetProcAddress(dll,"D3DXVec3TransformCoord");
    if(!check_version||!look_at||!matrix_translation||!matrix_multiply||!transform_coord)fail("Required D3DX math export missing");
    if(!check_version(32,43))fail("D3DXCheckVersion");
    if(look_at(&camera,&eye,&at,&up)!=&camera||camera.v[0]!=1||camera.v[5]!=1||camera.v[10]!=1)fail("D3DX LH camera conformance");
}
static void check_texture_abi(void){
    unsigned char bmp[58]={0x42,0x4d,58,0,0,0,0,0,0,0,54,0,0,0,40,0,0,0,1,0,0,0,1,0,0,0,1,0,24};
    struct { DWORD info[7]; DWORD canary; } metadata;
    HMODULE dll=GetModuleHandleA("d3dx9_43.dll");HANDLE file;DWORD written;IDirect3DTexture9 *texture=0;
    HRESULT (WINAPI *info)(LPCSTR,void*)=(void*)GetProcAddress(dll,"D3DXGetImageInfoFromFileA");
    HRESULT (WINAPI *load)(IDirect3DDevice9*,LPCSTR,IDirect3DTexture9**)=(void*)GetProcAddress(dll,"D3DXCreateTextureFromFileA");
    if(!info||!load)fail("D3DX texture ABI export missing");bmp[56]=255;
    file=CreateFileA("sample.bmp",GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);if(file==INVALID_HANDLE_VALUE)fail("CreateFileA BMP");
    if(!WriteFile(file,bmp,sizeof(bmp),&written,0)||written!=sizeof(bmp))fail("WriteFile BMP");CloseHandle(file);
    memset(&metadata,0,sizeof(metadata));metadata.canary=0x51a7cafe;
    checked(info("sample.bmp",metadata.info),"D3DXGetImageInfoFromFileA");
    if(metadata.canary!=0x51a7cafe||metadata.info[0]!=1||metadata.info[1]!=1||metadata.info[3]!=1||metadata.info[6]!=0)fail("D3DXIMAGE_INFO layout/source metadata");
    checked(load(device,"sample.bmp",&texture),"D3DXCreateTextureFromFileA");if(!texture)fail("D3DX returned null texture");IDirect3DTexture9_Release(texture);
}
#endif

typedef struct {float x,y,z,rhw;DWORD color;} Vertex;
static Vertex vertices[65*6];static unsigned vertex_count;
static void rectangle(int x,int y,int w,int h,DWORD color){
    static const unsigned indices[6]={0,1,2,0,2,3};unsigned i;float px[4],py[4];
#if SAMPLE_D3D == 9
    Matrix translation,scale={{(float)w,0,0,0,0,(float)h,0,0,0,0,1,0,0,0,0,1}},world;
    Vec corners[4]={{0,0,0},{1,0,0},{1,1,0},{0,1,0}},result;
    if(matrix_translation(&translation,(float)x,(float)y,0)!=&translation||matrix_multiply(&world,&scale,&translation)!=&world)fail("D3DX matrix result");
    for(i=0;i<4;i++){if(transform_coord(&result,&corners[i],&world)!=&result)fail("D3DX transform result");px[i]=result.x;py[i]=result.y;}
#else
    px[0]=px[3]=(float)x;px[1]=px[2]=(float)(x+w);py[0]=py[1]=(float)y;py[2]=py[3]=(float)(y+h);
#endif
    for(i=0;i<6;i++){unsigned k=indices[i];Vertex *v=&vertices[vertex_count++];v->x=px[k]-0.5f;v->y=py[k]-0.5f;v->z=0;v->rhw=1;v->color=color;}
}
void start(void){
    D3DPRESENT_PARAMETERS pp;unsigned i;initialize("GameBox " API_NAME " - arrow keys collect stars");memset(&pp,0,sizeof(pp));
    pp.Windowed=TRUE;pp.SwapEffect=D3DSWAPEFFECT_DISCARD;pp.hDeviceWindow=window_handle;pp.BackBufferWidth=WIDTH;pp.BackBufferHeight=HEIGHT;pp.BackBufferFormat=D3DFMT_UNKNOWN;
#if SAMPLE_D3D == 8
    d3d=Direct3DCreate8(D3D_SDK_VERSION);if(!d3d)fail("Direct3DCreate8");
    checked(IDirect3D8_CreateDevice(d3d,D3DADAPTER_DEFAULT,D3DDEVTYPE_HAL,window_handle,D3DCREATE_SOFTWARE_VERTEXPROCESSING,&pp,&device),"CreateDevice8");
    checked(CALL(SetVertexShader,D3DFVF_XYZRHW|D3DFVF_DIFFUSE),"SetVertexShader FVF");
#else
    pp.PresentationInterval=D3DPRESENT_INTERVAL_IMMEDIATE;
    d3d=Direct3DCreate9(D3D_SDK_VERSION);if(!d3d)fail("Direct3DCreate9");
    checked(IDirect3D9_CreateDevice(d3d,D3DADAPTER_DEFAULT,D3DDEVTYPE_HAL,window_handle,D3DCREATE_SOFTWARE_VERTEXPROCESSING,&pp,&device),"CreateDevice9");
    checked(CALL(SetFVF,D3DFVF_XYZRHW|D3DFVF_DIFFUSE),"SetFVF");check_d3dx();check_texture_abi();
#endif
    checked(CALL(SetRenderState,D3DRS_LIGHTING,FALSE),"SetRenderState lighting");checked(CALL(SetRenderState,D3DRS_CULLMODE,D3DCULL_NONE),"SetRenderState culling");checked(CALL(SetRenderState,D3DRS_ZENABLE,FALSE),"SetRenderState depth");
    while(running){LARGE_INTEGER begin;QueryPerformanceCounter(&begin);update_game();if(!running)break;vertex_count=0;
        for(i=0;i<64;i++)if(stars_x[i]>=0)rectangle(stars_x[i],stars_y[i],8,8,0xffffcc33);
        rectangle(player_x,player_y,12,12,0xff44ddff);
        checked(CALL(Clear,0,0,D3DCLEAR_TARGET,0xff102030,1.0f,0),"Clear");checked(BEGIN(),"BeginScene");
        checked(CALL(DrawPrimitiveUP,D3DPT_TRIANGLELIST,vertex_count/3,vertices,sizeof(Vertex)),"DrawPrimitiveUP");checked(END(),"EndScene");checked(CALL(Present,0,0,0,0),"Present");finish_frame(begin,API_NAME);
    }
#if SAMPLE_D3D == 8
    IDirect3DDevice8_Release(device);IDirect3D8_Release(d3d);
#else
    IDirect3DDevice9_Release(device);IDirect3D9_Release(d3d);
#endif
    shutdown_audio();DestroyWindow(window_handle);ExitProcess(0);
}
