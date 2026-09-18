/* SPDX-License-Identifier: MIT
 * Original, asset-free Win32 sample game support. No CRT or proprietary SDK files.
 */
#ifndef GAMEBOX_SAMPLE_COMMON_H
#define GAMEBOX_SAMPLE_COMMON_H
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <mmsystem.h>
#include <stdint.h>

#define WIDTH 640
#define HEIGHT 480
#define WARMUP 120
#define MEASURE 600
static HWND window_handle;
static int running = 1, benchmark = 0;
static unsigned frame_number, score, checksum = 2166136261u;
static int player_x = 310, player_y = 230;
static int stars_x[64], stars_y[64];
static LARGE_INTEGER frequency, launch_tick, first_present_tick;
static LONGLONG frame_ticks[MEASURE], total_ticks;
static HWAVEOUT audio;
static WAVEHDR audio_header;
static unsigned char audio_data[2205];
static int audio_requested;

void *memset(void *p, int value, unsigned int n) { unsigned char *d=p; while(n--) *d++=(unsigned char)value; return p; }
void *memcpy(void *p, const void *q, unsigned int n) { unsigned char *d=p; const unsigned char *s=q; while(n--) *d++=*s++; return p; }
static int contains(const char *text, const char *word) {
    for (; *text; text++) { const char *a=text,*b=word; while(*b && *a==*b){a++;b++;} if(!*b)return 1; } return 0;
}
static void fail(const char *message) {
    DWORD written; HANDLE file=CreateFileA("gamebox-sample-error.txt",GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);
    unsigned n=0; while(message[n])n++;
    if(file!=INVALID_HANDLE_VALUE){WriteFile(file,message,n,&written,0);CloseHandle(file);}
    OutputDebugStringA(message); ExitProcess(1);
}
static void checked(HRESULT hr, const char *operation) { if(FAILED(hr)) fail(operation); }
static LRESULT CALLBACK window_proc(HWND w, UINT m, WPARAM a, LPARAM b) {
    if(m==WM_DESTROY){running=0;PostQuitMessage(0);return 0;}
    return DefWindowProcA(w,m,a,b);
}
static void initialize(const char *title) {
    WNDCLASSA wc; RECT rect={0,0,WIDTH,HEIGHT}; unsigned i,seed=0x12345678u;
    if(!QueryPerformanceFrequency(&frequency)||!QueryPerformanceCounter(&launch_tick))fail("QPC unavailable");
    benchmark=contains(GetCommandLineA(),"--benchmark");
    audio_requested=contains(GetCommandLineA(),"--audio");
    memset(&wc,0,sizeof(wc));wc.lpfnWndProc=window_proc;wc.hInstance=GetModuleHandleA(0);wc.lpszClassName="GameBoxSample";
    if(!RegisterClassA(&wc))fail("RegisterClassA");
    AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,FALSE);
    window_handle=CreateWindowExA(0,wc.lpszClassName,title,WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,rect.right-rect.left,rect.bottom-rect.top,0,0,wc.hInstance,0);
    if(!window_handle)fail("CreateWindowExA");ShowWindow(window_handle,SW_SHOW);UpdateWindow(window_handle);
    for(i=0;i<64;i++){seed=seed*1664525u+1013904223u;stars_x[i]=20+(seed%600);seed=seed*1664525u+1013904223u;stars_y[i]=20+(seed%440);}
    if(audio_requested){
        WAVEFORMATEX fmt;memset(&fmt,0,sizeof(fmt));fmt.wFormatTag=WAVE_FORMAT_PCM;fmt.nChannels=1;fmt.nSamplesPerSec=22050;fmt.nAvgBytesPerSec=22050;fmt.nBlockAlign=1;fmt.wBitsPerSample=8;
        if(waveOutOpen(&audio,WAVE_MAPPER,&fmt,0,0,CALLBACK_NULL)!=MMSYSERR_NOERROR)fail("waveOutOpen");
        for(i=0;i<sizeof(audio_data);i++)audio_data[i]=(i%50<25)?144:112;
        memset(&audio_header,0,sizeof(audio_header));audio_header.lpData=(LPSTR)audio_data;audio_header.dwBufferLength=sizeof(audio_data);
        if(waveOutPrepareHeader(audio,&audio_header,sizeof(audio_header))!=MMSYSERR_NOERROR)fail("waveOutPrepareHeader");
        if(waveOutWrite(audio,&audio_header,sizeof(audio_header))!=MMSYSERR_NOERROR)fail("waveOutWrite");
    }
}
static void update_game(void) {
    MSG msg;unsigned i;
    while(PeekMessageA(&msg,0,0,0,PM_REMOVE)){if(msg.message==WM_QUIT)running=0;TranslateMessage(&msg);DispatchMessageA(&msg);}
    if(benchmark){player_x=20+(frame_number*3u)%600;player_y=20+(frame_number*7u)%440;}
    else {player_x+=3*((GetAsyncKeyState(VK_RIGHT)<0)-(GetAsyncKeyState(VK_LEFT)<0));player_y+=3*((GetAsyncKeyState(VK_DOWN)<0)-(GetAsyncKeyState(VK_UP)<0));}
    if(player_x<0)player_x=0;if(player_x>WIDTH-12)player_x=WIDTH-12;if(player_y<0)player_y=0;if(player_y>HEIGHT-12)player_y=HEIGHT-12;
    for(i=0;i<64;i++)if(stars_x[i]>=0 && player_x<stars_x[i]+8 && player_x+12>stars_x[i] && player_y<stars_y[i]+8 && player_y+12>stars_y[i]){score++;stars_x[i]=-100;}
    checksum=(checksum^(unsigned)player_x)*16777619u;checksum=(checksum^(unsigned)player_y)*16777619u;checksum=(checksum^score)*16777619u;
}
static char *append(char *p,const char *s){while(*s)*p++=*s++;return p;}
static char *number(char *p,uint64_t value){char digits[24];unsigned n=0;do{digits[n++]=(char)('0'+value%10);value/=10;}while(value);while(n)*p++=digits[--n];return p;}
static uint64_t micros(LONGLONG ticks){return (uint64_t)((ticks*1000000)/frequency.QuadPart);}
static void report(const char *api) {
    static char json[2048];char *p=json;DWORD written;HANDLE file;unsigned i,j;LONGLONG sorted[MEASURE];
    for(i=0;i<MEASURE;i++){LONGLONG x=frame_ticks[i];j=i;while(j && sorted[j-1]>x){sorted[j]=sorted[j-1];j--;}sorted[j]=x;}
    p=append(p,"{\"schemaVersion\":1,\"api\":\"");p=append(p,api);p=append(p,"\",\"mode\":\"guest-qpc\",\"warmupFrames\":120,\"measuredFrames\":600,\"checkedPresentCalls\":720,\"audioRequested\":");p=number(p,audio_requested);
    p=append(p,",\"firstPresentUs\":");p=number(p,micros(first_present_tick.QuadPart-launch_tick.QuadPart));
    p=append(p,",\"totalFrameUs\":");p=number(p,micros(total_ticks));p=append(p,",\"p50FrameUs\":");p=number(p,micros(sorted[299]));p=append(p,",\"p95FrameUs\":");p=number(p,micros(sorted[569]));p=append(p,",\"p99FrameUs\":");p=number(p,micros(sorted[593]));
    p=append(p,",\"simulationChecksum\":");p=number(p,checksum);p=append(p,",\"score\":");p=number(p,score);p=append(p,"}\n");*p=0;
    file=CreateFileA("gamebox-sample-result.json",GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);if(file==INVALID_HANDLE_VALUE)fail("CreateFileA result");
    if(!WriteFile(file,json,(DWORD)(p-json),&written,0)||written!=(DWORD)(p-json))fail("WriteFile result");CloseHandle(file);OutputDebugStringA(json);
}
static void finish_frame(LARGE_INTEGER start,const char *api) {
    LARGE_INTEGER end;QueryPerformanceCounter(&end);
    if(frame_number==0)first_present_tick=end;
    if(benchmark && frame_number>=WARMUP){frame_ticks[frame_number-WARMUP]=end.QuadPart-start.QuadPart;total_ticks+=end.QuadPart-start.QuadPart;}
    frame_number++;
    if(benchmark && frame_number==WARMUP+MEASURE){report(api);running=0;}
    if(!benchmark)Sleep(16);
}
static void shutdown_audio(void){if(audio){waveOutReset(audio);waveOutUnprepareHeader(audio,&audio_header,sizeof(audio_header));waveOutClose(audio);}}
#endif
