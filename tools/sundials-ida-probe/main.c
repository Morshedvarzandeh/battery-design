#include <ida/ida.h>
#include <nvector/nvector_serial.h>
#include <sundials/sundials_config.h>
#include <sundials/sundials_context.h>
#include <sundials/sundials_errors.h>
#include <sundials/sundials_types.h>
#include <sundials/sundials_version.h>
#include <sunlinsol/sunlinsol_dense.h>
#include <sunmatrix/sunmatrix_dense.h>

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if SUNDIALS_VERSION_MAJOR != 7 || SUNDIALS_VERSION_MINOR != 8 ||              \
  SUNDIALS_VERSION_PATCH != 0
#error "The lifecycle probe requires SUNDIALS 7.8.0 headers"
#endif

#if !defined(SUNDIALS_DOUBLE_PRECISION)
#error "The lifecycle probe requires double-precision SUNDIALS"
#endif

#if !defined(SUNDIALS_INT64_T)
#error "The lifecycle probe requires 64-bit SUNDIALS indices"
#endif

_Static_assert(sizeof(sunrealtype) == sizeof(double),
               "sunrealtype must have the double ABI");
_Static_assert(sizeof(sunindextype) * CHAR_BIT == 64,
               "sunindextype must have a 64-bit ABI");

static void report_sundials_error(const char* operation, SUNErrCode code)
{
  fprintf(stderr, "%s failed: %s (%d)\n", operation, SUNGetErrMsg(code), code);
}

int main(void)
{
  static const sunindextype probe_size = 1;
  static const char expected_version[] = "7.8.0";

  SUNContext context            = NULL;
  N_Vector vector               = NULL;
  SUNMatrix matrix              = NULL;
  SUNLinearSolver linear_solver = NULL;
  void* ida_memory              = NULL;
  char runtime_version[32]      = {0};
  char runtime_label[32]        = {0};
  int runtime_major             = 0;
  int runtime_minor             = 0;
  int runtime_patch             = 0;
  SUNErrCode code;
  int status = EXIT_FAILURE;

  code = SUNDIALSGetVersion(runtime_version, (int)sizeof(runtime_version));
  if (code != SUN_SUCCESS)
  {
    report_sundials_error("SUNDIALSGetVersion", code);
    goto cleanup;
  }
  if (strcmp(runtime_version, expected_version) != 0)
  {
    fprintf(stderr, "SUNDIALS runtime version mismatch: expected %s, received %s\n",
            expected_version, runtime_version);
    goto cleanup;
  }

  code = SUNDIALSGetVersionNumber(&runtime_major, &runtime_minor, &runtime_patch,
                                  runtime_label, (int)sizeof(runtime_label));
  if (code != SUN_SUCCESS)
  {
    report_sundials_error("SUNDIALSGetVersionNumber", code);
    goto cleanup;
  }
  if (runtime_major != 7 || runtime_minor != 8 || runtime_patch != 0 ||
      runtime_label[0] != '\0')
  {
    fprintf(stderr,
            "SUNDIALS runtime version components mismatch: expected 7.8.0 with "
            "an empty label, received %d.%d.%d%s%s\n",
            runtime_major, runtime_minor, runtime_patch,
            runtime_label[0] == '\0' ? "" : "-", runtime_label);
    goto cleanup;
  }

  code = SUNContext_Create(SUN_COMM_NULL, &context);
  if (code != SUN_SUCCESS)
  {
    report_sundials_error("SUNContext_Create", code);
    goto cleanup;
  }
  if (context == NULL)
  {
    fputs("SUNContext_Create succeeded without returning a context\n", stderr);
    goto cleanup;
  }

  vector = N_VNew_Serial(probe_size, context);
  if (vector == NULL)
  {
    fputs("N_VNew_Serial failed\n", stderr);
    goto cleanup;
  }
  if (N_VGetVectorID(vector) != SUNDIALS_NVEC_SERIAL ||
      N_VGetLength(vector) != probe_size)
  {
    fputs("N_VNew_Serial returned an unexpected vector implementation\n", stderr);
    goto cleanup;
  }

  matrix = SUNDenseMatrix(probe_size, probe_size, context);
  if (matrix == NULL)
  {
    fputs("SUNDenseMatrix failed\n", stderr);
    goto cleanup;
  }
  if (SUNMatGetID(matrix) != SUNMATRIX_DENSE ||
      SUNDenseMatrix_Rows(matrix) != probe_size ||
      SUNDenseMatrix_Columns(matrix) != probe_size)
  {
    fputs("SUNDenseMatrix returned an unexpected matrix implementation\n", stderr);
    goto cleanup;
  }

  linear_solver = SUNLinSol_Dense(vector, matrix, context);
  if (linear_solver == NULL)
  {
    fputs("SUNLinSol_Dense failed\n", stderr);
    goto cleanup;
  }
  if (SUNLinSolGetID(linear_solver) != SUNLINEARSOLVER_DENSE)
  {
    fputs("SUNLinSol_Dense returned an unexpected linear solver implementation\n",
          stderr);
    goto cleanup;
  }

  ida_memory = IDACreate(context);
  if (ida_memory == NULL)
  {
    fputs("IDACreate failed\n", stderr);
    goto cleanup;
  }

  status = EXIT_SUCCESS;

cleanup:
  if (ida_memory != NULL)
  {
    IDAFree(&ida_memory);
    if (ida_memory != NULL)
    {
      fputs("IDAFree did not clear the IDA memory pointer\n", stderr);
      status = EXIT_FAILURE;
    }
  }

  if (linear_solver != NULL)
  {
    code          = SUNLinSolFree(linear_solver);
    linear_solver = NULL;
    if (code != SUN_SUCCESS)
    {
      report_sundials_error("SUNLinSolFree", code);
      status = EXIT_FAILURE;
    }
  }

  if (matrix != NULL)
  {
    SUNMatDestroy(matrix);
    matrix = NULL;
  }

  if (vector != NULL)
  {
    N_VDestroy(vector);
    vector = NULL;
  }

  if (context != NULL)
  {
    code = SUNContext_Free(&context);
    if (code != SUN_SUCCESS)
    {
      report_sundials_error("SUNContext_Free", code);
      status = EXIT_FAILURE;
    }
    if (context != NULL)
    {
      fputs("SUNContext_Free did not clear the context pointer\n", stderr);
      status = EXIT_FAILURE;
    }
  }

  if (status == EXIT_SUCCESS)
  {
    puts("SUNDIALS 7.8.0 IDA serial+dense lifecycle probe passed; no "
         "initialization or solve was performed.");
  }
  return status;
}
