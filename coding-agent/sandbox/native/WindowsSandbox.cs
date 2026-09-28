using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class WindowsSandboxNative
{
    const uint Suspended=4, NoWindow=0x08000000, UnicodeEnv=0x400, Extended=0x80000, UseStd=0x100, DisablePrivileges=1;
    const uint KillOnClose=0x2000, ActiveProcess=8, JobTime=4, ProcessMemory=0x100, JobMemory=0x200;
    static readonly IntPtr SecurityCapabilitiesAttribute = new IntPtr(0x00020009);

    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reserved2Ptr,stdIn,stdOut,stdErr; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int processId,threadId; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential)] struct LUID { public uint low; public int high; }
    [StructLayout(LayoutKind.Sequential)] struct LUID_AND_ATTRIBUTES { public LUID luid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES label; }
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr appContainerSid,capabilities; public int capabilityCount,reserved; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }

    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int c,IntPtr p,uint l);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint c);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr h);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr h,uint c);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int c,int f,ref IntPtr s);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr l,uint f,IntPtr a,IntPtr v,IntPtr s,IntPtr p,IntPtr r);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX si,out PROCESS_INFORMATION pi);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint a,out IntPtr t);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr e,uint f,uint dc,[In] SID_AND_ATTRIBUTES[] ds,uint pc,[In] LUID_AND_ATTRIBUTES[] ps,uint rc,[In] SID_AND_ATTRIBUTES[] rs,out IntPtr t);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr t,uint a,IntPtr sa,int i,int ty,out IntPtr n);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr t,int c,IntPtr p,int l);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr t,int c,IntPtr p,int l,out int needed);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr t,string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string s,out IntPtr p);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern int CreateAppContainerProfile(string n,string d,string x,IntPtr c,uint count,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string n,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern int DeleteAppContainerProfile(string n);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

    public static string EnsureAppContainer(string name)
    {
        IntPtr sid; int result=DeriveAppContainerSidFromAppContainerName(name,out sid);
        if(result!=0) result=CreateAppContainerProfile(name,name,"Coding Agent temporary sandbox",IntPtr.Zero,0,out sid);
        if(result!=0) throw new Win32Exception(result,"无法创建 AppContainer Profile");
        try { return new SecurityIdentifier(sid).Value; } finally { LocalFree(sid); }
    }

    public static string GetLogonSid()
    {
        IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;
        try {
            Check(OpenProcessToken(GetCurrentProcess(),0x0008,out token),"无法读取当前令牌");
            int needed; GetTokenInformation(token,2,IntPtr.Zero,0,out needed);
            buffer=Marshal.AllocHGlobal(needed); Check(GetTokenInformation(token,2,buffer,needed,out needed),"无法读取令牌组");
            uint count=(uint)Marshal.ReadInt32(buffer); int offset=IntPtr.Size==8?8:4; int size=Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for(int index=0;index<count;index++){var group=(SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(buffer,offset+index*size),typeof(SID_AND_ATTRIBUTES));if((group.attributes&0xC0000000)==0xC0000000)return new SecurityIdentifier(group.sid).Value;}
            throw new InvalidOperationException("Current token has no Logon SID.");
        } finally { Free(buffer);Close(token); }
    }

    public static int RunAppContainer(string profile,string executable,string[] args,string cwd,int timeout,int processes,long memory,int cpu,bool internet)
    {
        IntPtr sid; Check(DeriveAppContainerSidFromAppContainerName(profile,out sid)==0,"无法读取 AppContainer SID");
        IntPtr internetSid=IntPtr.Zero,capPtr=IntPtr.Zero,securityPtr=IntPtr.Zero,list=IntPtr.Zero;
        try {
            var security=new SECURITY_CAPABILITIES { appContainerSid=sid };
            if(internet) { Check(ConvertStringSidToSid("S-1-15-3-1",out internetSid),"无法创建网络 Capability SID"); var cap=new SID_AND_ATTRIBUTES { sid=internetSid,attributes=4 }; capPtr=Marshal.AllocHGlobal(Marshal.SizeOf(cap)); Marshal.StructureToPtr(cap,capPtr,false); security.capabilities=capPtr; security.capabilityCount=1; }
            securityPtr=Marshal.AllocHGlobal(Marshal.SizeOf(security)); Marshal.StructureToPtr(security,securityPtr,false);
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); list=Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list,1,0,ref size),"初始化 AppContainer 属性失败");
            Check(UpdateProcThreadAttribute(list,0,SecurityCapabilitiesAttribute,securityPtr,new IntPtr(Marshal.SizeOf(security)),IntPtr.Zero,IntPtr.Zero),"设置 AppContainer 属性失败");
            var startup=StartupEx(); startup.attributes=list; PROCESS_INFORMATION pi;
            Check(CreateProcess(null,CommandLine(executable,args),IntPtr.Zero,IntPtr.Zero,true,Suspended|UnicodeEnv|Extended,IntPtr.Zero,cwd,ref startup,out pi),"AppContainer 进程启动失败");
            return Control(pi,timeout,processes,memory,cpu);
        } finally { if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);} Free(securityPtr);Free(capPtr);if(internetSid!=IntPtr.Zero)LocalFree(internetSid);if(sid!=IntPtr.Zero)LocalFree(sid); }
    }

    public static int RunRestricted(string sandboxSid,string executable,string[] args,string cwd,int timeout,int processes,long memory,int cpu)
    {
        IntPtr current=IntPtr.Zero,restricted=IntPtr.Zero,primary=IntPtr.Zero;
        try {
            Check(OpenProcessToken(GetCurrentProcess(),0x000F01FF,out current),"无法打开当前令牌");
            Check(CreateRestrictedToken(current,DisablePrivileges,0,null,0,null,0,null,out restricted),"无法创建受限令牌");
            Check(DuplicateTokenEx(restricted,0x000F01FF,IntPtr.Zero,2,1,out primary),"无法复制主令牌");
            var startup=Startup(false); PROCESS_INFORMATION pi;
            Check(CreateProcessAsUser(primary,executable,CommandLine(executable,args),IntPtr.Zero,IntPtr.Zero,true,Suspended|NoWindow|UnicodeEnv,IntPtr.Zero,cwd,ref startup,out pi),"受限令牌进程启动失败");
            return Control(pi,timeout,processes,memory,cpu);
        } finally { Close(primary);Close(restricted);Close(current); }
    }

    static int Control(PROCESS_INFORMATION pi,int timeout,int processes,long memory,int cpu)
    {
        IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"无法创建 Job Object");
        try {
            var info=new EXTENDED_LIMITS(); info.basic.flags=KillOnClose|ActiveProcess|ProcessMemory|JobMemory; info.basic.activeProcesses=(uint)processes; info.processMemory=new UIntPtr((ulong)memory); info.jobMemory=new UIntPtr((ulong)memory);
            if(cpu>0){info.basic.flags|=JobTime;info.basic.jobTime=cpu*10000000L;} IntPtr ptr=Marshal.AllocHGlobal(Marshal.SizeOf(info));
            try { Marshal.StructureToPtr(info,ptr,false); Check(SetInformationJobObject(job,9,ptr,(uint)Marshal.SizeOf(info)),"无法设置 Job Object 限制"); } finally { Marshal.FreeHGlobal(ptr); }
            Check(AssignProcessToJobObject(job,pi.process),"无法将进程加入 Job Object"); Check(ResumeThread(pi.thread)!=uint.MaxValue,"无法恢复沙箱进程");
            uint wait=WaitForSingleObject(pi.process,timeout<=0?uint.MaxValue:(uint)timeout*1000); if(wait==0x102){TerminateJobObject(job,124);return 124;} uint code; Check(GetExitCodeProcess(pi.process,out code),"无法读取退出码"); return unchecked((int)code);
        } finally { Close(pi.thread);Close(pi.process);Close(job); }
    }

    static STARTUPINFO Startup(bool desktop){return new STARTUPINFO { cb=Marshal.SizeOf(typeof(STARTUPINFO)),desktop=desktop?"winsta0\\default":null,flags=(int)UseStd,stdIn=GetStdHandle(-10),stdOut=GetStdHandle(-11),stdErr=GetStdHandle(-12) };}
    static STARTUPINFOEX StartupEx(){var value=new STARTUPINFOEX { startup=Startup(true) };value.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));return value;}
    static StringBuilder CommandLine(string exe,string[] args){var values=new List<string>{Quote(exe)};foreach(var arg in args)values.Add(Quote(arg));return new StringBuilder(string.Join(" ",values));}
    static string Quote(string value){if(value.Length==0)return "\"\"";if(value.IndexOfAny(new[]{' ','\t','\"'})<0)return value;var b=new StringBuilder("\"");int slash=0;foreach(char c in value){if(c=='\\'){slash++;continue;}b.Append('\\',c=='\"'?slash*2+1:slash);slash=0;b.Append(c);}b.Append('\\',slash*2);return b.Append('\"').ToString();}
    static void Check(bool ok,string message){if(!ok){int code=Marshal.GetLastWin32Error();throw new Win32Exception(code,message+" ("+code+": "+new Win32Exception(code).Message+")");}}
    static void Close(IntPtr p){if(p!=IntPtr.Zero)CloseHandle(p);}
    static void Free(IntPtr p){if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);}
}
