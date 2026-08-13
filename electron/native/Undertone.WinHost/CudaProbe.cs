using System;
using System.Runtime.InteropServices;

internal sealed class CudaStatus
{
    public bool DriverPresent;
    public bool Compatible;
    public int DriverApiVersion;
    public int DeviceCount;
}

internal static class CudaProbe
{
    private const int ComputeCapabilityMajor = 75;
    private const int ComputeCapabilityMinor = 76;

    [DllImport("nvcuda.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int cuInit(uint flags);

    [DllImport("nvcuda.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int cuDriverGetVersion(out int driverVersion);

    [DllImport("nvcuda.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int cuDeviceGetCount(out int count);

    [DllImport("nvcuda.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int cuDeviceGetAttribute(out int value, int attribute, int device);

    public static CudaStatus Detect()
    {
        var status = new CudaStatus();
        try
        {
            status.DriverPresent = true;
            if (cuInit(0) != 0)
                return status;
            cuDriverGetVersion(out status.DriverApiVersion);
            if (cuDeviceGetCount(out status.DeviceCount) != 0)
                return status;
            for (var device = 0; device < status.DeviceCount; device++)
            {
                int major;
                int minor;
                if (cuDeviceGetAttribute(out major, ComputeCapabilityMajor, device) == 0
                    && cuDeviceGetAttribute(out minor, ComputeCapabilityMinor, device) == 0
                    && IsPackagedArchitecture(major, minor))
                {
                    status.Compatible = status.DriverApiVersion >= 12000;
                    break;
                }
            }
        }
        catch (DllNotFoundException)
        {
            status.DriverPresent = false;
        }
        catch (EntryPointNotFoundException)
        {
            status.DriverPresent = false;
        }
        return status;
    }

    private static bool IsPackagedArchitecture(int major, int minor)
    {
        return (major == 7 && minor == 5)
            || (major == 8 && (minor == 6 || minor == 9))
            || (major == 12 && minor == 0);
    }
}
