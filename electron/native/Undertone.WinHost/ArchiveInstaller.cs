using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;

internal static class ArchiveInstaller
{
    public static int ExtractSubset(
        IList<string> zipFiles,
        IList<string> patterns,
        string targetDirectory,
        Func<bool> isCancelled = null)
    {
        if (zipFiles == null || zipFiles.Count == 0)
            throw new InvalidOperationException("No runtime archives were supplied");
        if (patterns == null || patterns.Count == 0)
            throw new InvalidOperationException("No runtime file patterns were supplied");
        if (string.IsNullOrEmpty(targetDirectory))
            throw new InvalidOperationException("Runtime target directory is missing");

        var staging = targetDirectory + ".tmp";
        if (Directory.Exists(staging))
            Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);
        var extracted = 0;
        try
        {
            foreach (var zipFile in zipFiles)
            {
                ThrowIfCancelled(isCancelled);
                using (var archive = ZipFile.OpenRead(zipFile))
                {
                    foreach (var entry in archive.Entries)
                    {
                        ThrowIfCancelled(isCancelled);
                        var fileName = Path.GetFileName(entry.FullName);
                        if (string.IsNullOrEmpty(fileName)
                            || !Matches(fileName, patterns))
                            continue;
                        var destination = Path.Combine(staging, fileName);
                        Extract(entry, destination, isCancelled);
                        extracted += 1;
                    }
                }
            }
            if (extracted == 0)
                throw new InvalidOperationException("Runtime archives contained no expected files");
            ThrowIfCancelled(isCancelled);
            if (Directory.Exists(targetDirectory))
                Directory.Delete(targetDirectory, true);
            ThrowIfCancelled(isCancelled);
            Directory.Move(staging, targetDirectory);
            return extracted;
        }
        catch
        {
            if (Directory.Exists(staging))
                Directory.Delete(staging, true);
            throw;
        }
    }

    private static void Extract(
        ZipArchiveEntry entry,
        string destination,
        Func<bool> isCancelled)
    {
        var buffer = new byte[81920];
        using (var input = entry.Open())
        using (var output = new FileStream(
            destination, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                ThrowIfCancelled(isCancelled);
                output.Write(buffer, 0, count);
            }
        }
    }

    private static void ThrowIfCancelled(Func<bool> isCancelled)
    {
        if (isCancelled != null && isCancelled())
            throw new OperationCanceledException("Extraction parent disconnected");
    }

    private static bool Matches(string fileName, IList<string> patterns)
    {
        foreach (var pattern in patterns)
        {
            var expression = "^" + Regex.Escape(pattern)
                .Replace("\\*", ".*")
                .Replace("\\?", ".") + "$";
            if (Regex.IsMatch(fileName, expression, RegexOptions.IgnoreCase))
                return true;
        }
        return false;
    }
}
