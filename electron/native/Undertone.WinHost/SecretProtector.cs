using System;
using System.Security.Cryptography;
using System.Text;

internal static class SecretProtector
{
    private const string Prefix = "dpapi:";

    public static string Protect(string value)
    {
        var plain = Encoding.UTF8.GetBytes(value ?? string.Empty);
        var protectedValue = ProtectedData.Protect(
            plain, null, DataProtectionScope.CurrentUser);
        return Prefix + Convert.ToBase64String(protectedValue);
    }

    public static string Unprotect(string value)
    {
        if (value == null || !value.StartsWith(Prefix, StringComparison.Ordinal))
            return value ?? string.Empty;
        try
        {
            var protectedValue = Convert.FromBase64String(value.Substring(Prefix.Length));
            var plain = ProtectedData.Unprotect(
                protectedValue, null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch
        {
            return string.Empty;
        }
    }
}
